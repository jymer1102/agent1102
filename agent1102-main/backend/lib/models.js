// Which AI models the chat uses (override with the TEXT_MODEL / VISION_MODEL environment variables).
// gpt-oss can't see images, so any request that contains an image goes to a vision model instead.
const TEXT_MODEL = process.env.TEXT_MODEL || "openai/gpt-oss-120b";
const VISION_MODEL = process.env.VISION_MODEL || "qwen/qwen3.8-27b";
const MAX_IMAGES_PER_REQUEST = 3; // qwen/qwen3.8-27b's hard limit is 3 images per request; older images are dropped to keep requests within that

module.exports = { TEXT_MODEL, VISION_MODEL, MAX_IMAGES_PER_REQUEST };
