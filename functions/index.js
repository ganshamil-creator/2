// functions/index.js
//
// Две HTTP Cloud Functions для Хаба 2:
//
// 1) proxy — универсальный исходящий прокси (замена api/proxy.js на Vercel).
//    Принимает POST {url, headers, body}, проверяет url по белому списку
//    разрешённых хостов AI-провайдеров, делает fetch и возвращает ответ.
//    Используется хабом из браузера через относительный путь /api/proxy
//    (Hosting rewrite направляет его сюда).
//
// 2) samsungWebhook — приём данных от HC Webhook (Android-приложение на
//    телефоне), конвертация формата Health Connect в формат хаба
//    (wr.steps / wr.heartRate) и сохранение в тот же Firestore-документ,
//    куда пишет сам хаб (users/{uid}/health/wearable, обёртка
//    {__profiles, __allData}).
//
// ВАЖНО: admin.initializeApp() без аргументов — в среде Cloud Functions
// учётные данные подхватываются автоматически (через сервис-аккаунт
// функции), отдельный JSON-ключ или переменные окружения для этого
// не нужны (в отличие от версии на Vercel).

const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");

if (!admin.apps.length) {
  admin.initializeApp();
}
const db = admin.firestore();

// ── Общие CORS-заголовки ───────────────────────────────────────
function setCors(res) {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
}

// ════════════════════════════════════════════════════════════════
// 1) PROXY — исходящий прокси к AI-провайдерам
// ════════════════════════════════════════════════════════════════
const ALLOWED_HOSTS = [
  "api.anthropic.com",
  "api.openai.com",
  "generativelanguage.googleapis.com",
  "api.perplexity.ai",
  "api.moonshot.ai",
  "api.moonshot.cn",
  "api.deepseek.com"
];

exports.proxy = onRequest(
  {
    cors: true,
    region: "us-central1",
    invoker: "public",
    timeoutSeconds: 180,
    memory: "256MiB"
  },
  async (req, res) => {
    setCors(res);

    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }

    if (req.method === "GET") {
      res.status(200).json({ status: "ok", endpoint: "proxy" });
      return;
    }

    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    try {
      const { url, headers, body } = req.body || {};
      if (!url || typeof url !== "string") {
        res.status(400).json({ error: "Missing url" });
        return;
      }

      let parsed;
      try {
        parsed = new URL(url);
      } catch (e) {
        res.status(400).json({ error: "Invalid url" });
        return;
      }

      if (!ALLOWED_HOSTS.includes(parsed.hostname)) {
        res.status(403).json({ error: "Host not allowed: " + parsed.hostname });
        return;
      }

      const fetchHeaders = headers || {};
      const fetchOptions = {
        method: "POST",
        headers: { "Content-Type": "application/json", ...fetchHeaders }
      };
      if (body !== undefined) {
        fetchOptions.body = typeof body === "string" ? body : JSON.stringify(body);
      }

      const upstream = await fetch(url, fetchOptions);
      const text = await upstream.text();

      res.status(upstream.status);
      try {
        res.json(JSON.parse(text));
      } catch (e) {
        res.send(text);
      }
    } catch (err) {
      console.error("proxy error:", err);
      res.status(500).json({ error: err.message || "Proxy error" });
    }
  }
);

// ════════════════════════════════════════════════════════════════
// 2) SAMSUNG WEBHOOK — приём данных Health Connect
// ════════════════════════════════════════════════════════════════

// Секрет сравнивается с переменной окружения SAMSUNG_WEBHOOK_SECRET,
// которая подставляется при деплое из functions/.env (см. GitHub Actions).
function checkToken(req) {
  const token = req.query.token;
  const expected = process.env.SAMSUNG_WEBHOOK_SECRET;
  return expected && token === expected;
}

// Берёт дату (YYYY-MM-DD) из ISO-строки времени
function dateOf(iso) {
  if (!iso) return null;
  return String(iso).split("T")[0];
}

// Конвертирует payload от HC Webhook в формат wr.steps / wr.heartRate хаба
function convertHealthConnectPayload(payload) {
  const wr = { steps: [], heartRate: [] };

  // Шаги — суммируем по дате (берём дату конца интервала)
  const stepsByDate = {};
  (payload.steps || []).forEach((s) => {
    const d = dateOf(s.end_time || s.start_time);
    if (!d || typeof s.count !== "number") return;
    stepsByDate[d] = (stepsByDate[d] || 0) + s.count;
  });
  Object.keys(stepsByDate).forEach((d) => {
    wr.steps.push({ date: d, value: stepsByDate[d], unit: "шаг/день" });
  });

  // Пульс — усредняем по дате
  const hrByDate = {};
  (payload.heart_rate || []).forEach((h) => {
    const d = dateOf(h.time);
    if (!d || typeof h.bpm !== "number") return;
    if (!hrByDate[d]) hrByDate[d] = { sum: 0, count: 0 };
    hrByDate[d].sum += h.bpm;
    hrByDate[d].count++;
  });
  Object.keys(hrByDate).forEach((d) => {
    const avg = Math.round(hrByDate[d].sum / hrByDate[d].count);
    wr.heartRate.push({ date: d, value: avg, unit: "уд/мин" });
  });

  return wr;
}

// Сливает новые записи (по дате) в существующий массив, заменяя совпадения по дате
function mergeByDate(existing, incoming) {
  const arr = (existing || []).filter(
    (e) => !incoming.some((n) => n.date === e.date)
  );
  return arr.concat(incoming).sort((a, b) => (a.date > b.date ? 1 : -1));
}

exports.samsungWebhook = onRequest(
  { region: "us-central1", invoker: "public", timeoutSeconds: 60, memory: "256MiB" },
  async (req, res) => {
    setCors(res);

    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }

    if (req.method === "GET") {
      res.status(200).json({ status: "ok", endpoint: "samsung-webhook" });
      return;
    }

    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    try {
      if (!checkToken(req)) {
        res.status(401).json({ error: "Invalid token" });
        return;
      }

      const uid = req.query.uid;
      if (!uid || typeof uid !== "string") {
        res.status(400).json({ error: "Missing uid" });
        return;
      }

      const payload = req.body || {};
      const incoming = convertHealthConnectPayload(payload);

      const docRef = db
        .collection("users")
        .doc(uid)
        .collection("health")
        .doc("wearable");

      const snap = await docRef.get();
      let profiles = { me: { name: "Я", icon: "👤", age: 35, gender: "m", color: "#6366f1" } };
      let allData = { me: { biomarkers: {}, wearable: {}, diary: {}, lastUpdated: null } };

      if (snap.exists) {
        const existing = snap.data();
        try {
          if (existing.__profiles) profiles = JSON.parse(existing.__profiles);
        } catch (e) {}
        try {
          if (existing.__allData) allData = JSON.parse(existing.__allData);
        } catch (e) {}
      }

      if (!allData.me) allData.me = { biomarkers: {}, wearable: {}, diary: {}, lastUpdated: null };
      if (!allData.me.wearable) allData.me.wearable = {};

      const wr = allData.me.wearable;
      wr.steps = mergeByDate(wr.steps, incoming.steps);
      wr.heartRate = mergeByDate(wr.heartRate, incoming.heartRate);
      allData.me.lastUpdated = Date.now();

      await docRef.set({
        __profiles: JSON.stringify(profiles),
        __allData: JSON.stringify(allData),
        ts: Date.now()
      });

      res.status(200).json({
        status: "ok",
        stepsAdded: incoming.steps.length,
        heartRateAdded: incoming.heartRate.length
      });
    } catch (err) {
      console.error("samsungWebhook error:", err);
      res.status(500).json({ error: err.message || "Webhook error" });
    }
  }
);
