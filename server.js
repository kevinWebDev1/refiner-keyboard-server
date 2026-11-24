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
// Flagship Gemini models for users who bring their own Google API Key
const USER_GEMINI_MODELS = [
    "gemini-3.5-flash-lite", // Primary: Ultra-fast typing autocomplete
    "gemini-3.1-flash-lite", // Backup 1: Ultra-fast
    "gemini-2.0-flash",      // Backup 2: Proven flagship
    "gemini-1.5-flash",      // Backup 3: Stable fallback
    "gemini-3.8-flash",      // Backup 4: High intelligence
    "gemini-4-hydrogen"      // Last resort: High-quality reasoning
];

// Free tier models using the server's GEMINI_FREE_API_KEY (14,400 RPD safety net)
const FREE_TIER_MODELS = [
    "gemma-4-26b-a4b-it",    // Primary: MoE 4B active, 14,400 RPD safety net
    "gemma-4-31b-it",        // Backup 1: Dense 31B, 14,400 RPD safety net
    "gemini-3.5-flash-lite", // Backup 2: 500 RPD fallback
    "gemini-3.1-flash-lite"  // Backup 3: 500 RPD fallback
];
const GROQ_MODELS = [
    "llama-3.1-8b-instant",     // Primary: Ultra-low latency
    "llama-3.3-70b-versatile",  // Primary: High accuracy / 70B intelligence
    "llama-3.2-3b-preview",     // Backup 1: Lightweight fallback
    "gemma2-9b-it",             // Backup 2: Open-weights alternative fallback
    "mixtral-8x7b-32768"        // Backup 3: MoE fallback
];
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
async function callGemini(text, apiKey, prompt, models = USER_GEMINI_MODELS) {
    for (const model of models) {
        try {
            const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
            const response = await axios.post(
                API_URL,
                {
                    contents: [{ role: "user", parts: [{ text: prompt }] }],
                },
                { headers: { "Content-Type": "application/json" }, timeout: 10000 }
            );

            const resultText = response.data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
            if (resultText) {
                return resultText;
            }
        } catch (err) {
            console.warn(`Gemini model ${model} failed with status:`, err.response?.status || err.message);
        }
    }
    throw new Error("All Gemini models failed");
}

async function callGroq(text, prompt) {
    if (!process.env.GROQ_API_KEY) throw new Error("Groq API Key Missing");

    const { Groq } = require("groq-sdk");
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

    for (const model of GROQ_MODELS) {
        try {
            const completion = await groq.chat.completions.create({
                model: model,
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
            console.warn(`Groq model ${model} failed with status:`, e.message);
        }
    }
    throw new Error("All Groq models failed");
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
            ? `Fix typos, spelling, and grammar in the input text while strictly preserving the EXACT same language, script, slang, and dialect (if Romanized Hindi/Hinglish, keep Hinglish; if Hindi, keep Hindi; if English, keep English). Never translate to English or any other language unless the input was already in that language. Output ONLY the corrected text with no explanations or quotes.\nInput: ${userText}`
            : `Reply briefly and clearly.\n${userText}`;

    try {
        let resultText;

        if (userApiKey) {
            // User brought their own API Key -> Always use flagship Gemini models!
            try {
                resultText = await callGemini(userText, userApiKey, prompt, USER_GEMINI_MODELS);
            } catch (geminiErr) {
                console.warn("User Gemini key failed, falling back to Groq:", geminiErr.message);
                resultText = await callGroq(userText, prompt);
            }
        } else {
            // Free user (no API key) -> Try Gemma 4 (14,400 RPD pool) using server key, fallback to Groq
            const serverApiKey = process.env.GEMINI_FREE_API_KEY || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;

            if (serverApiKey) {
                try {
                    resultText = await callGemini(userText, serverApiKey, prompt, FREE_TIER_MODELS);
                } catch (gemmaErr) {
                    console.warn("Server Gemma/Gemini failed, falling back to Groq:", gemmaErr.message);
                    resultText = await callGroq(userText, prompt);
                }
            } else {
                resultText = await callGroq(userText, prompt);
            }

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
    const latestVersion = "3.2.0";

    // Quick semantic version check
    const isNewer = (latest, current) => {
        const lParts = latest.split(".");
        const cParts = current.split(".");
        for (let i = 0; i < Math.max(lParts.length, cParts.length); i++) {
            const l = parseInt(lParts[i]) || 0;
            const c = parseInt(cParts[i]) || 0;
            if (l > c) return true;
            if (l < c) return false;
        }
        return false;
    };

    const updateAvailable = isNewer(latestVersion, clientVersion);

    res.json({
        updateAvailable,
        latestVersion,
        forceUpdate: false,
        updateUrl: "https://refiner-backend.vercel.app",
        changelog: `🚀 Refiner v3.2.0 is Live! 

• New Refiner Vault: Secure password manager with biometrics
• UI Enhancements: Better translation chips & cleaner Numpad
• Dynamic Next-Word Prediction: Local Mind learns as you type
• Smart Auto-Cleanup: Instant background clipboard purging
• UX Polish: Flawless update checks & smart selection logic`,
    });
});

app.get("/", (_, res) => res.send("Refiner AI Backend Live"));

if (process.env.NODE_ENV !== "production") {
    app.listen(PORT, () => console.log(`Server running on ${PORT}`));
}

module.exports = app;