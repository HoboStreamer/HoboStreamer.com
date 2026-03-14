# HoboStreamer — Restream Channel Branding Guide

> These Twitch/Kick/YouTube channels exist to **advertise HoboStreamer** and funnel viewers to the main platform. Every element should make visitors curious about HoboStreamer.com and give them a reason to come over.

**Brand colors:** Gold/amber `#c0965c`, dark background `#1e1e24`, flame highlight `#dbb077`, signal red `#e74c3c`  
**Logo motif:** Tent + campfire + broadcast signal waves  
**Tagline:** "Live Streaming for Camp Culture"  
**URL:** `https://hobostreamer.com`  
**Discord:** `https://discord.gg/M6MuRUaeJj`  
**GitHub:** `https://github.com/HoboStreamer/HoboStreamer.com`

---

## 1. Profile Avatar / Profile Picture (All Platforms)

Used as: Twitch profile picture, Kick avatar, YouTube channel icon. Should be recognizable at small sizes (110×110 on Twitch, even smaller in chat).

### Image Generation Prompt

> **Prompt:** A minimalist logo icon on a pure black background. A stylized camping tent in dark charcoal gray with gold-amber (#c0965c) outline strokes. A small campfire with warm amber-gold flames sits in front of the tent. Two curved broadcast/WiFi signal arcs emanate from the top-right of the tent in gold, with a tiny red (#e74c3c) dot at the signal origin. Clean vector style, no text, no gradients, flat design with subtle depth. Square format, centered composition. High contrast against black for readability at small sizes.

### Notes
- Keep it simple — this is viewed at 28–110px. No fine details.
- The existing SVG logo at `public/assets/logo.svg` is the reference design.
- Generate at **512×512** minimum, export as PNG with transparent or black background.
- Use the same avatar across all three platforms for brand consistency.

---

## 2. Profile Banner / Channel Banner

Used as: Twitch profile banner (1200×480), Kick banner (1920×480), YouTube banner (2560×1440 safe area 1546×423).

### Image Generation Prompt

> **Prompt:** A wide cinematic banner for a streaming channel. The scene is a nighttime outdoor camp — a small tent glowing warmly from inside, a crackling campfire in the foreground casting amber-gold light, and a dark starry sky above. The mood is cozy, adventurous, off-grid. Overlaid on the right side in clean modern sans-serif typography: "HoboStreamer" in large gold-amber (#c0965c) text with "Streamer" in bold, and below it in smaller white text: "hobostreamer.com". Subtle broadcast signal arcs near the text suggest live streaming. Dark cinematic color grading. Wide aspect ratio (21:9 or wider). No people, no faces.

### Notes
- Generate at **2560×1440** to cover YouTube's requirement, then crop to platform sizes.
- Keep key text/elements in the center safe zone (1546×423) so it's visible on all devices.
- Alternative: Generate without text and add "HoboStreamer" + "hobostreamer.com" yourself in an image editor for crisper typography.

---

## 3. Under-Stream Panels (Twitch & Kick)

Twitch and Kick both support info panels below the stream. Standard panel image size: **320×100 px** (Twitch) or similar banners. Each panel has a **header image** and **description text** below it.

---

### Panel 1: "Watch on HoboStreamer" (THE MAIN CTA)

This is the most important panel — it should be the first one visitors see.

#### Header Image Prompt

> **Prompt:** A streaming panel header banner (320×100 pixels, 3.2:1 ratio). Dark background (#1e1e24). On the left, a small stylized campfire icon with amber-gold flames. In the center, bold modern text reading "WATCH ON HOBOSTREAMER" in gold-amber (#c0965c). A subtle right-pointing arrow or "go" indicator on the right side. Clean, minimal, high contrast. Flat design.

#### Description Text

```
🏕️ This stream is rebroadcast from HoboStreamer.com — a free, open-source streaming platform built for outdoor culture.

👉 Watch the FULL experience at:
   https://hobostreamer.com

✅ No ads, no subs, no paywalls
✅ Interactive chat with emotes & cosmetics
✅ Built-in browser game
✅ Open source — run your own instance

Come hang out on the real thing!
```

---

### Panel 2: "About This Stream"

#### Header Image Prompt

> **Prompt:** A streaming panel header banner (320×100 pixels). Dark background (#1e1e24). A small tent icon on the left in gold outline. Bold text reading "ABOUT" in clean white sans-serif, with a thin gold (#c0965c) underline accent. Minimal, flat design, high contrast.

#### Description Text

```
This is a rebroadcast from HoboStreamer — a self-hosted live streaming platform for stealth campers, nomads, and outdoor IRL creators.

The stream you're watching originates at hobostreamer.com where you'll get the best quality, lowest latency, and full interactive features.

The platform is 100% free, open source, and community-driven.
```

---

### Panel 3: "Why HoboStreamer?"

#### Header Image Prompt

> **Prompt:** A streaming panel header banner (320×100 pixels). Dark background (#1e1e24). A glowing campfire ember icon on the left. Bold text "WHY HOBOSTREAMER?" in gold-amber (#c0965c), clean modern font. Subtle broadcast signal arcs as a watermark in the background. Minimal flat design.

#### Description Text

```
🔥 Why watch on HoboStreamer instead of here?

• Better stream quality (direct, not reencoded)
• Lower latency — chat in real time
• Custom emotes, hats, name effects & particles
• Chat-integrated browser game (HoboGame)
• VODs & clips
• No corporate algorithms, no ads
• Community-built by campers, for campers

→ hobostreamer.com
```

---

### Panel 4: "Community / Discord"

#### Header Image Prompt

> **Prompt:** A streaming panel header banner (320×100 pixels). Dark background (#1e1e24). The Discord logo (simplified blurple circle) on the left. Bold text "JOIN THE COMMUNITY" in white with a gold (#c0965c) accent line. Clean, minimal, flat design.

#### Description Text

```
💬 Join the HoboStreamer Discord!

Chat with the community, suggest features, report bugs, or just hang out.

→ https://discord.gg/M6MuRUaeJj
```

---

### Panel 5: "Open Source"

#### Header Image Prompt

> **Prompt:** A streaming panel header banner (320×100 pixels). Dark background (#1e1e24). A code bracket icon "< />" or Git branch icon on the left in gold-amber (#c0965c). Bold text "OPEN SOURCE" in white. A subtle GitHub octocat silhouette watermarked in the background at low opacity. Clean flat design.

#### Description Text

```
🛠️ HoboStreamer is fully open source.

The entire platform — streaming server, chat, game, everything — is on GitHub. Run your own instance, contribute, or just read the code.

⭐ https://github.com/HoboStreamer/HoboStreamer.com

Built with Node.js, WebSockets, SQLite, FFmpeg, and mediasoup.
```

---

### Panel 6: "HoboApp" (Optional Cross-Promo)

#### Header Image Prompt

> **Prompt:** A streaming panel header banner (320×100 pixels). Dark background (#1e1e24). A tiny map pin / campground icon on the left in gold-amber. Bold text "HOBOAPP" in gold, with smaller subtitle "Camp Locator" in white below. A faint topographic map line pattern in the background at very low opacity. Clean flat design.

#### Description Text

```
🗺️ HoboApp — Stealth Camp & Shelter Locator

A free desktop app with 300+ hand-curated stealth camping locations in Washington State. 18 data sources on one interactive map.

📥 https://github.com/HoboStreamer/HoboApp
   Windows · Linux · macOS
```

---

## 4. Channel Bio / About Section

### Twitch Bio (300 char max)

```
🏕️ Rebroadcast from HoboStreamer.com — free open-source streaming for stealth campers & nomads. Better quality + interactive chat + browser game on the real site → hobostreamer.com | Discord: discord.gg/M6MuRUaeJj
```

### Kick Bio

```
🏕️ This stream is rebroadcast from HoboStreamer.com — a free, open-source live streaming platform built for outdoor culture, stealth campers, and nomads. Watch the real stream with full features at hobostreamer.com
```

### YouTube Channel Description

```
HoboStreamer — Live Streaming for Camp Culture 🏕️

This channel rebroadcasts live streams from HoboStreamer.com, a free and open-source streaming platform built for stealth campers, nomads, and outdoor IRL creators.

For the best experience — better quality, lower latency, interactive chat, custom emotes, a built-in browser game, and more — watch directly at:
🔗 https://hobostreamer.com

HoboStreamer is 100% free, open source, and community-driven.
📂 Source code: https://github.com/HoboStreamer/HoboStreamer.com
💬 Discord: https://discord.gg/M6MuRUaeJj
🗺️ HoboApp (camp locator): https://github.com/HoboStreamer/HoboApp
```

---

## 5. Stream Title Templates

Use these as your stream title on Twitch/Kick/YouTube to drive traffic:

```
🏕️ Live from HoboStreamer.com — Watch the real stream at hobostreamer.com!
```
```
Rebroadcast from HoboStreamer — Full experience at hobostreamer.com 🏕️🔥
```
```
🔴 LIVE on HoboStreamer.com — Free open-source streaming platform | hobostreamer.com
```

---

## 6. Stream Category / Tags

### Twitch
- **Category:** "Just Chatting" or "IRL" (or whatever fits the stream content)
- **Tags:** `OpenSource`, `IRL`, `Outdoors`, `Camping`, `VanLife`, `SelfHosted`, `Community`

### Kick
- **Category:** "Just Chatting" or "IRL"

### YouTube
- **Tags:** `hobostreamer`, `live streaming`, `open source`, `stealth camping`, `IRL`, `nomad`, `van life`, `outdoor streaming`, `self-hosted`

---

## 7. Offline Screen / Thumbnail (Optional)

Shown when the stream is offline.

### Image Generation Prompt

> **Prompt:** A streaming offline screen (1920×1080). A moody nighttime campsite scene — a tent in silhouette, a campfire reduced to glowing embers, stars overhead. Centered text in large gold-amber (#c0965c) sans-serif: "STREAM OFFLINE" with smaller white text below: "Watch live at hobostreamer.com". The overall mood is peaceful, quiet, end-of-night. Dark color grading with warm amber highlights from the dying fire. Cinematic composition.

---

## 8. Stream Overlay Watermark (Optional)

A small persistent watermark in the corner of the stream itself.

### Image Generation Prompt

> **Prompt:** A small transparent watermark badge (300×80 pixels, PNG with transparency). Text reading "hobostreamer.com" in clean white sans-serif with a subtle dark drop shadow for readability on any background. A tiny campfire icon before the text. Semi-transparent (designed to be placed at 30-50% opacity in OBS). No background.

### OBS Setup
- Add as an Image source in OBS
- Position: bottom-right corner
- Opacity: 30–50%
- This ensures every frame of the restream advertises the URL

---

## Quick Reference: Image Sizes

| Asset | Twitch | Kick | YouTube |
|-------|--------|------|---------|
| Avatar | 256×256 (shown 112×112) | 256×256 | 800×800 |
| Banner | 1200×480 | 1920×480 | 2560×1440 (safe: 1546×423) |
| Panel headers | 320×100 | ~320×100 | N/A (use cards) |
| Offline screen | 1920×1080 | 1920×1080 | 1920×1080 |
| Thumbnail | 1280×720 | 1280×720 | 1280×720 |

---

## Tips

- **Consistency is key** — use the same avatar, same gold-on-dark palette, same "HoboStreamer" branding across all platforms so people recognize the brand.
- **The URL is the payload** — every single element should contain or point to `hobostreamer.com`. It's the whole reason these channels exist.
- **Keep it genuine** — don't try to compete with Twitch/Kick/YouTube. Frame it as "the real stream is over there, this is just a taste."
- **Pin a chat message** on Twitch/Kick with: `🏕️ Watch the full stream with interactive chat at https://hobostreamer.com`
