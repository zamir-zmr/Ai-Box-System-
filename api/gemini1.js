// api/gemini1.js  ->  endpoint: /api/gemini1
const MODEL = 'gemini-flash-lite-latest';

// Dual-panel layout rules: hamesha frontend ke instruction ke BAAD lagte hain,
// isliye frontend inhe override nahi kar sakta.
const LAYOUT_RULES = `
=== OUTPUT LAYOUT RULES (STRICT, ALWAYS FOLLOW) ===
The UI has two panels: LEFT and RIGHT. Wrap EVERY part of your answer in panel tags:
[LEFT]...[/LEFT]   and/or   [RIGHT]...[/RIGHT]

Routing:
1. Fruits / fruit names / anything about fruits  -> ONLY inside [LEFT]...[/LEFT].
2. Vegetables / vegetable names / anything about vegetables -> ONLY inside [RIGHT]...[/RIGHT].
3. If the user names the panels explicitly (e.g. "write fruit on the left and vegetables on the right",
   "vegetables on the left", "video on the right"), follow that assignment EXACTLY, even if it
   swaps the defaults above.
4. If the user asks for both fruits and vegetables with no positions, fruits -> LEFT, vegetables -> RIGHT.
5. If the user asks for only ONE side, output ONLY that panel's tag. Never write the other panel.
6. For any other topic with no position given, put the answer in [LEFT]. If the user says "right", use [RIGHT].

List format (interactive checklist):
- Write items ONE PER LINE as "- Name" (English name only, no numbering, no descriptions unless the user asks; if asked, use "- Name: description").
- Each "- Name" line becomes a checkbox in the UI.

Ticking:
7. The system context may contain "CURRENT LIST STATE" = the items now on screen and which are [ticked]. Use it.
8. If the user asks to tick / check / mark / done / cross off items (e.g. "Tick Apple", "Apple ko tick karo", "sab fruits tick karo"),
   reply ONLY with [TICK]Apple, Mango[/TICK]  (names separated by commas, spelled exactly as in CURRENT LIST STATE).
   "All" / "sab" = every item of that panel. No panel tags, no other text.
9. If the user asks to untick / uncheck / remove the tick, reply ONLY with [UNTICK]Apple[/UNTICK].
10. If one request both creates a list and ticks items, write the panel block(s) first, then the [TICK] block using the names from the list you just wrote.

Format:
- Do NOT write any text outside the tags. No greetings, no preamble, no closing line.
- Open a tag, write the content, close the tag, then (if needed) open the next one. Never nest tags.
- Use the exact uppercase tags [LEFT] [/LEFT] [RIGHT] [/RIGHT] [TICK] [/TICK] [UNTICK] [/UNTICK]. Never mention or explain the tags.
- Inside a panel use plain text; **bold** allowed. No HTML, no code fences.
- Reply in the same language the user writes in (Hindi / Hinglish / English).
`.trim();

// Frontend se systemInstruction string, {text}, ya {parts:[{text}]} - teeno chalenge.
function extractInstructionText(si) {
  if (!si) return '';
  if (typeof si === 'string') return si;
  if (typeof si.text === 'string') return si.text;
  if (Array.isArray(si.parts)) {
    return si.parts.map(p => (p && typeof p.text === 'string' ? p.text : '')).filter(Boolean).join('\n');
  }
  return '';
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: { message: 'Method not allowed' } });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY_1;
  if (!apiKey) {
    res.status(500).json({ error: { message: 'Server misconfigured: GEMINI_API_KEY_1 missing' } });
    return;
  }

  const { contents, systemInstruction } = req.body || {};
  if (!Array.isArray(contents) || contents.length === 0) {
    res.status(400).json({ error: { message: 'Missing or invalid "contents" in request body' } });
    return;
  }

  // Frontend ka dynamic instruction + hamare fixed layout rules
  const frontendText =
    extractInstructionText(systemInstruction) ||
    'Current device time is requested. User location is Oman (GST, UTC+4). Respond using exact user local time.';

  const finalSystemInstruction = {
    parts: [{ text: `${frontendText}\n\n${LAYOUT_RULES}` }]
  };

  const upstreamUrl =
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:streamGenerateContent?alt=sse&key=${apiKey}`;

  // Client tab band kare / Stop dabaye to upstream bhi cancel ho jaye
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  try {
    const upstreamResponse = await fetch(upstreamUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents, systemInstruction: finalSystemInstruction }),
      signal: controller.signal
    });

    if (!upstreamResponse.ok || !upstreamResponse.body) {
      let detail = null;
      try { detail = await upstreamResponse.json(); } catch (_) {}
      res.status(upstreamResponse.status || 502).json({
        error: { message: detail?.error?.message || `Gemini API error: ${upstreamResponse.status}` }
      });
      return;
    }

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    const reader = upstreamResponse.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
      if (typeof res.flush === 'function') res.flush();
    }
    res.end();
  } catch (err) {
    if (controller.signal.aborted) {
      if (!res.writableEnded) res.end();
      return;
    }
    if (res.headersSent) {
      // Stream beech mein toot gayi - frontend ko error event bhejo
      res.write(`data: ${JSON.stringify({ error: { message: 'Stream interrupted: ' + err.message } })}\n\n`);
      res.end();
      return;
    }
    res.status(502).json({ error: { message: 'Failed to reach Gemini API', detail: err.message } });
  }
}
