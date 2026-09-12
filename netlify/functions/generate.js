// netlify/functions/generate.js
//
// Secure middleman: frontend -> this function -> Hugging Face Inference API.
// NEVER exposes HUGGINGFACE_API_KEY to the browser.
//
// Pipeline:
//   Step 1: text (+ optional reference image, + W/H) -> black-forest-labs/FLUX.1-schnell -> base image
//   Step 2: base image -> briaai/RMBG-1.4 (image-segmentation) -> foreground mask
//   Step 3: composite base + mask with `sharp` -> transparent PNG -> return base64 data URL
//
// Env var required (set in Netlify dashboard > Site settings > Environment variables):
//   HUGGINGFACE_API_KEY = hf_xxxx  (needs "Inference Providers" permission)

const sharp = require("sharp");

const FLUX_MODEL = "black-forest-labs/FLUX.1-schnell";
const RMBG_MODEL = "briaai/RMBG-1.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

const round16 = (n) => Math.max(16, Math.round(n / 16) * 16);
const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

function dataUrlToBuffer(dataUrl) {
  // "data:image/png;base64,iVBOR..." -> { buffer, mime }
  const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl || "");
  if (!m) throw new Error("referenceImage must be a base64 data URL.");
  return { mime: m[1], buffer: Buffer.from(m[2], "base64") };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: corsHeaders,
      body: JSON.stringify({ error: "Method not allowed. Use POST." }),
    };
  }

  const apiKey = process.env.HUGGINGFACE_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({
        error: "Server misconfigured: HUGGINGFACE_API_KEY is not set in Netlify environment variables.",
      }),
    };
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: "Invalid JSON body." }) };
  }

  const prompt = String(body.prompt || "").trim();
  if (!prompt) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: "prompt is required." }) };
  }
  if (prompt.length > 1500) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: "prompt is too long (max 1500 chars)." }) };
  }

  // Clamp + snap dimensions to multiples of 16 (FLUX requirement). Keep POD-friendly range.
  let width = clamp(parseInt(body.width, 10) || 1024, 256, 2048);
  let height = clamp(parseInt(body.height, 10) || 1024, 256, 2048);
  width = round16(width);
  height = round16(height);

  let referenceBuffer = null;
  if (body.referenceImage) {
    try {
      const parsed = dataUrlToBuffer(body.referenceImage);
      if (parsed.buffer.length > 4 * 1024 * 1024) {
        return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: "Reference image too large (max 4MB)." }) };
      }
      referenceBuffer = parsed.buffer;
    } catch (e) {
      return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: e.message }) };
    }
  }

  // POD-optimized prompt engineering: force an isolated, centered, print-ready subject.
  const enhancedPrompt =
    `${prompt}, isolated single centered object, print-on-demand t-shirt graphic, ` +
    `clean sharp edges, high detail, solid simple background, no text, no watermark` +
    (referenceBuffer ? `, matching the style and subject of the reference image` : "");

  try {
    // Dynamic import keeps this CommonJS function compatible with the ESM-only HF SDK.
    const { InferenceClient } = await import("@huggingface/inference");
    const client = new InferenceClient(apiKey);

    // ---------- STEP 1: FLUX.1-schnell ----------
    let baseBlob;
    if (referenceBuffer) {
      // FLUX.1-schnell on HF Inference is primarily text-to-image. Some providers
      // accept an init image (img2img). Try img2img first, fall back to text-to-image.
      try {
        baseBlob = await client.imageToImage({
          model: FLUX_MODEL,
          inputs: new Blob([referenceBuffer]),
          parameters: {
            prompt: enhancedPrompt,
            strength: 0.7,
            num_inference_steps: 4,
            guidance_scale: 3.5,
            width,
            height,
          },
        });
      } catch {
        baseBlob = await client.textToImage({
          model: FLUX_MODEL,
          inputs: enhancedPrompt,
          parameters: { width, height, num_inference_steps: 4, guidance_scale: 3.5 },
        });
      }
    } else {
      baseBlob = await client.textToImage({
        model: FLUX_MODEL,
        inputs: enhancedPrompt,
        parameters: { width, height, num_inference_steps: 4, guidance_scale: 3.5 },
      });
    }

    const baseBuffer = Buffer.from(await baseBlob.arrayBuffer());
    if (!baseBuffer.length) throw new Error("FLUX returned an empty image.");

    // ---------- STEP 2: RMBG-1.4 background removal ----------
    let transparentPng;
    let warning = null;
    try {
      const segments = await client.imageSegmentation({
        model: RMBG_MODEL,
        inputs: new Blob([baseBuffer]),
      });

      if (!Array.isArray(segments) || segments.length === 0 || !segments[0].mask) {
        throw new Error("Segmentation returned no mask.");
      }
      // Highest-confidence segment = foreground.
      const best = [...segments].sort((a, b) => (b.score || 0) - (a.score || 0))[0];
      const maskBuffer = Buffer.from(await best.mask.arrayBuffer());

      transparentPng = await applyMaskAsAlpha(baseBuffer, maskBuffer);
    } catch (segErr) {
      // Graceful fallback: still deliver the FLUX base image as PNG so the user isn't blocked.
      // (Common causes: RMBG cold-start timeout, gated-license 403 on some providers.)
      warning = `Background removal failed (${segErr.message}). Returning base image without transparency.`;
      transparentPng = await sharp(baseBuffer).png().toBuffer();
    }

    const base64 = transparentPng.toString("base64");
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        image: `data:image/png;base64,${base64}`,
        width,
        height,
        warning,
      }),
    };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    // Surface HF provider errors (401/402/503 model-loading) readably.
    const status = /401|unauthorized|invalid.*token/i.test(msg) ? 502 : 500;
    return { statusCode: status, headers: corsHeaders, body: JSON.stringify({ error: `Generation failed: ${msg}` }) };
  }
};

/**
 * Composite: base RGB + grayscale segmentation mask -> RGBA transparent PNG.
 * Pure-raw pipeline (no compositing ambiguity across sharp versions).
 */
async function applyMaskAsAlpha(baseBuffer, maskBuffer) {
  const baseMeta = await sharp(baseBuffer).metadata();
  const w = baseMeta.width || 1024;
  const h = baseMeta.height || 1024;

  const { data: rgb, info } = await sharp(baseBuffer)
    .removeAlpha()
    .resize(w, h, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const alpha = await sharp(maskBuffer)
    .grayscale()
    .resize(info.width, info.height, { fit: "fill" })
    .raw()
    .toBuffer();

  // mask may come back as multi-channel raw; first byte of each pixel = luminance.
  const channels = alpha.length / (info.width * info.height);
  const rgba = Buffer.alloc(info.width * info.height * 4);
  for (let i = 0; i < info.width * info.height; i++) {
    rgba[i * 4] = rgb[i * 3];
    rgba[i * 4 + 1] = rgb[i * 3 + 1];
    rgba[i * 4 + 2] = rgb[i * 3 + 2];
    rgba[i * 4 + 3] = alpha[Math.floor(i * channels)];
  }

  return sharp(rgba, { raw: { width: info.width, height: info.height, channels: 4 } })
    .png()
    .toBuffer();
}
