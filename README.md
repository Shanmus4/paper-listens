# Paper Listens

Play your music, the paper is listening.

**Live site: https://paperlistens.vercel.app/**

**Paper Listens** turns any sound into watercolor. Play a guitar, sing, hum, beatbox, or upload a song, and it paints onto a sheet of paper in real time, like ink spreading in water. The colors are not random: every musical note maps to its own color and its own spot on the page, so the same song always paints the same picture. Bright, happy scales paint in vibrant colors. Dark, moody scales paint in muted ones. Drums add their own grey ink texture.

It is a kind of synesthesia for your browser, hearing turned into seeing.

## Who is this for

Anyone curious about the link between music and color. Musicians who want to *see* what they play. People who just want to make something beautiful by making noise. No coding knowledge needed to use it, just a microphone or an audio file and a browser.

## How it works (in plain English)

1. The browser listens to your microphone (with your permission), or reads an audio file you upload.
2. It breaks the sound down into musical notes, loudness, and brightness, many times a second.
3. Each note gets a color and a fixed position on the page. Louder notes paint bigger.
4. The app figures out which musical scale you are in and adjusts how vibrant the whole painting feels.
5. Notes flow onto the paper like colored ink dropped in water. Playing the same note again gently dims its earlier mark instead of piling up dark. Drums become grey ink.

Nothing is uploaded to a server. All the listening and painting happens on your own device.

## Tech

- Plain HTML, CSS, and JavaScript. No framework, no build step.
- **Web Audio API** to capture and read sound.
- **Meyda** for audio features (loudness, brightness, note content).
- **Pitchy** for clear single-note pitch, plus a custom FFT and a small polyphonic detector for chords and overlapping notes.
- **WebGL2** runs a fluid (ink-in-water) simulation that does the actual painting.
- Hosted on **Vercel** as a static site.

## Run it locally

You need a recent version of Node.js installed (for the simple local server).

```bash
# from the project folder
npm run dev
```

Then open the printed URL (usually http://localhost:3000) in your browser and allow microphone access, or open Controls and upload a file.

> A microphone needs a secure context. `localhost` counts as secure, so local development works. If you open the raw `index.html` file directly (a `file://` URL) the microphone will not work.

## Deploy

The app is a static site, so deploying is just publishing the folder.

- **Vercel (current host):** connect the GitHub repo to Vercel. There is no build step, so leave the build command empty and set the output to the project root. `vercel.json` already turns on clean URLs. Every push to `main` redeploys automatically.
- **Any static host:** upload `index.html`, `styles.css`, `src/`, and `assets/` as-is. The site must be served over HTTPS for the microphone to work.

## Controls

- **Source**: switch between Microphone and Upload (drop or browse for MP3, WAV, OGG, M4A, FLAC).
- **Show note grid**: overlay the note positions on the page. Off by default.
- **Show live readout**: show what the app is hearing right now. Off by default.
- **Record**: capture your session.
- **New Sheet**: clear the paper and start fresh.
- **Save**: name your piece and download it as a PNG image.

## Roadmap

- **Now**: live microphone painting and full-song upload, with notes, chords, vocals, and drums all leaving marks.
- **Next**: paste a track link, more painting styles (minimal, maximal), sensitivity controls.
- **Later**: undo and shareable links.

## Troubleshooting

- **Nothing paints from the mic**: check the browser asked for and got microphone permission. Look for a mic icon in the address bar.
- **Microphone permission never appears**: you may be opening the file directly. Use `npm run dev` and open `localhost` instead.
- **Uploaded song shows a spinner for a while**: the whole song is analyzed up front so you can scrub through it. Longer files take longer. Let it finish.
- **iPhone Safari shows nothing**: tap the page first. Audio cannot start on iOS until you tap.

## License

MIT
