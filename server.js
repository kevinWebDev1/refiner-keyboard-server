const express = require("express");
const cors = require("cors");
const axios = require("axios");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 5000;

// ---------------------- MIDDLEWARE ----------------------
app.use(cors());
app.use(express.json());

// ---------------------- CONFIG ----------------------
const MODEL_NAME_GEMINI = "gemini-2.5-flash-lite";
const GROQ_MODEL = "llama-3.1-8b-instant"; // Groq model names don't use slashes! "qwen/qwen3-32b" is an OpenRouter format.
const DAILY_LIMIT = 30;

// ---------------------- IN-MEMORY LIMIT ----------------------
const usageMap = new Map();
const getTodayDate = () => new Date().toISOString().split("T")[0];

const checkRateLimit = (deviceId) => {
    if (!deviceId) return { allowed: false, error: "Missing Device ID" };

    const today = getTodayDate();
    let stats = usageMap.get(deviceId);

    if (!stats || stats.date !== today) {
        stats = { count: 0, date: today };
        usageMap.set(deviceId, stats);
    }

    if (stats.count >= DAILY_LIMIT) {
        return { allowed: false, error: "Daily limit reached." };
    }
    return { allowed: true };
};

const incrementUsage = (deviceId) => {
    const stats = usageMap.get(deviceId);
    if (stats) stats.count++;
};

// ---------------------- OUTPUT CLEANER ----------------------
function cleanGroqOutput(text = "") {
    return text
        .replace(/<think>[\s\S]*?<\/think>/gi, "")
        .replace(/<\/?think>/gi, "")
        .replace(/\n+/g, " ")
        .replace(/\s{2,}/g, " ")
        .trim();
}

// ---------------------- AI HANDLERS ----------------------
async function callGemini(text, apiKey, prompt) {
    const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME_GEMINI}:generateContent?key=${apiKey}`;

    try {
        const response = await axios.post(
            API_URL,
            {
                contents: [{ role: "user", parts: [{ text: prompt }] }],
            },
            { headers: { "Content-Type": "application/json" } }
        );

        return response.data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    } catch {
        throw new Error("Gemini Failed");
    }
}

async function callGroq(text, prompt) {
    if (!process.env.GROQ_API_KEY) throw new Error("Groq API Key Missing");

    const { Groq } = require("groq-sdk");
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

    try {
        const completion = await groq.chat.completions.create({
            model: GROQ_MODEL,
            temperature: 0.6,
            top_p: 0.95,
            max_completion_tokens: 4096,
            stream: false,
            messages: [
                {
                    role: "system",
                    content:
                        "You are a text tool inside a keyboard app. Output ONLY the final refined text. No explanations, no greetings, no reasoning, no <think> blocks.",
                },
                {
                    role: "user",
                    content: prompt,
                },
            ],
        });

        const raw = completion.choices[0]?.message?.content || "";
        return cleanGroqOutput(raw);
    } catch (e) {
        console.error("Groq Error:", e.message);
        throw new Error("Groq Failed");
    }
}

// ---------------------- MAIN HANDLER ----------------------
const handleRequest = async (req, res, type) => {
    const userText = req.body.text?.trim();
    const userApiKey = req.headers.authorization?.replace("Bearer ", "");
    const deviceId = req.headers["x-device-id"];

    if (!userText) return res.status(400).json({ error: "Missing 'text'" });

    // Rate limit only for free tier
    if (!userApiKey) {
        const check = checkRateLimit(deviceId);
        if (!check.allowed) return res.status(429).json({ error: check.error });
    }

    const prompt =
        type === "refine"
            ? `decode this text, understand what user wanna type. Fix grammar and spelling. result should be exactly in same way. Return ONLY the result.\nInput: ${userText}`
            : `Reply briefly and clearly.\n${userText}`;

    try {
        let resultText;

        if (userApiKey) {
            try {
                resultText = await callGemini(userText, userApiKey, prompt);
            } catch {
                resultText = await callGroq(userText, prompt);
            }
        } else {
            resultText = await callGroq(userText, prompt);
            incrementUsage(deviceId);
        }

        const key = type === "refine" ? "refinedText" : "chatText";
        res.json({ [key]: resultText });
    } catch (err) {
        console.error("Server Error:", err.message);
        res.status(502).json({ error: "AI Service Failed" });
    }
};

// ---------------------- ROUTES ----------------------
app.post("/refine", (req, res) => handleRequest(req, res, "refine"));
app.post("/chat", (req, res) => handleRequest(req, res, "chat"));

app.get("/app-update", (req, res) => {
    const clientVersion = req.query.version || "0.0";
    const latestVersion = "3.1.0";
    const updateAvailable = clientVersion !== latestVersion;

    res.json({
        updateAvailable,
        latestVersion,
        forceUpdate: false,
        updateUrl: "https://kevinwebstore.vercel.app",
        changelog: `🚀 Refiner v3.1.0 is Live! 

• New Password Manager: Secure Vault with Biometric support
• Enhanced Security: App-wide FLAG_SECURE protection
• UI Polish: Modern Material switches & refined layout
• Smarter Logic: Improved phrase replacement & unified controls
• Logic Fixes: Backend sync & storage reliability`,
    });
});

app.get("/", (_, res) => res.send("Refiner AI Backend Live"));

if (process.env.NODE_ENV !== "production") {
    app.listen(PORT, () => console.log(`Server running on ${PORT}`));
}

module.exports = app;
