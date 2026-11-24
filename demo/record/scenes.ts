// The README demo storyboard, played against the dev UI with ?demo data. Run through record.sh, not on its own.
// Every mark starts the GIF of that name (demo/<name>.gif); "end" closes the last one.
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { META, Page, sleep } from "./cdp";

const work = process.argv[2] ?? "/tmp/sauron-demo";
const url = process.env.DEMO_URL ?? "http://localhost:1420/";
const settings = encodeURIComponent(JSON.stringify({ theme: "graphite", appearance: "dark" }));

const p = new Page(work);
await p.launch();
await p.goto(`${url}?demo&settings=${settings}`);
await p.waitFor("document.querySelector('.query-editor .view-lines') && document.querySelectorAll('.conn-name').length > 0");
await sleep(800);
await p.startRecording(`${work}/frames`);

let failed = false;
try {
  // SQL: write a query with completion, run it, open a record and step through rows.
  p.mark("demo");
  await sleep(900);
  for (let i = 0; ; i++) {
    await p.click(".query-editor .view-lines", undefined, { dx: 200, dy: -20 });
    await sleep(300);
    if (await p.eval("!!document.activeElement?.closest('.monaco-editor')")) break;
    if (i > 10) throw new Error("the editor never took focus");
  }
  await p.key("a", META, ["selectAll"]);
  await p.key("Backspace");
  await sleep(250);
  const lines = [
    "select o.id, c.name as customer, o.status, o.total, o.created_at, o.meta",
    "from orders o join customers c on c.id = o.customer_id",
    "where o.status = 'paid'",
    "order by o.created_at desc",
  ];
  for (let i = 0; i < lines.length; i++) {
    await p.type(lines[i], 38);
    await sleep(120);
    // Close the completion list so Enter starts a new line instead of accepting a suggestion.
    await p.key("Escape");
    if (i < lines.length - 1) await p.key("Enter");
  }
  await sleep(500);
  await p.key("Enter", META);
  await sleep(1800);
  await p.click(".table-section tbody tr:nth-child(4)");
  await sleep(2600);
  await p.key("j");
  await sleep(900);
  await p.key("j");
  await sleep(1400);

  // Schema tab, then the command palette switches to the Kafka connection.
  await p.click(".sidebar-modes button", "Schema");
  await sleep(1300);
  await p.click(".schema-panel .t-row", "orders", { exact: false });
  await sleep(1600);
  await p.key("k", META);
  await sleep(900);
  await p.type("@kaf", 90);
  await sleep(900);
  await p.key("Enter");
  await sleep(1500);

  // Kafka: read a topic with a JSON field filter and open a message.
  p.mark("kafka");
  await p.click(".kafka-form input[placeholder^='one of']");
  await p.type("order-events", 45);
  await sleep(300);
  await p.key("Escape");
  await sleep(500);
  await p.click(".kafka-form button", "Add filter", { exact: false });
  await sleep(500);
  await p.click(".kafka-form input[aria-label='Filter field']");
  await p.key("a", META, ["selectAll"]);
  await p.type("value.status", 45);
  await p.click(".kafka-form input[aria-label='Filter value']");
  await p.type("paid", 60);
  await sleep(500);
  await p.click(".execute-button");
  await sleep(1800);
  await p.click(".table-section tbody tr:nth-child(3)");
  await sleep(2800);

  // Themes: light Paper, then Forest, back to Graphite.
  p.mark("themes");
  await p.key(",", META);
  await sleep(1200);
  await p.click("button", "Light");
  await sleep(1300);
  await p.click(".theme-card", "Paper", { exact: false });
  await sleep(1600);
  await p.click("button", "Dark");
  await sleep(500);
  await p.click(".theme-card", "Forest", { exact: false });
  await sleep(1400);
  await p.click(".theme-card", "Graphite", { exact: false });
  await sleep(1000);
  await p.key("Escape");
  await sleep(1200);
  p.mark("end");
} catch (error) {
  failed = true;
  console.error(error);
  await p.screenshot(`${work}/failed.png`).catch(() => {});
  console.error(`screenshot of the failure: ${work}/failed.png`);
}
await p.stopRecording();
p.close();
if (failed || p.frames.length === 0) process.exit(1);

// Chrome sends a frame only when something changed, so resample to a steady 30 fps: slot n links to the frame
// that was on screen at n / 30 seconds. (ffmpeg's concat list rounds every frame's duration and drifts.)
const FPS = 30;
const first = p.frames[0].t;
const seq = `${work}/seq`;
rmSync(seq, { recursive: true, force: true });
mkdirSync(seq);
const total = Math.ceil((p.frames[p.frames.length - 1].t - first + 1) * FPS);
for (let n = 0, i = 0; n < total; n++) {
  while (i + 1 < p.frames.length && p.frames[i + 1].t - first <= n / FPS) i++;
  symlinkSync(p.frames[i].file, `${seq}/${String(n).padStart(5, "0")}.jpg`);
}
// Marks use our clock, frames Chrome's: a mark starts at the first frame that arrived after it.
const at = (mark: { t: number }) => (p.frames.find((frame) => frame.arrived >= mark.t) ?? p.frames[p.frames.length - 1]).t - first;
const cuts = p.marks.slice(0, -1).map((mark, i) => `${mark.name} ${at(mark).toFixed(2)} ${at(p.marks[i + 1]).toFixed(2)}`);
writeFileSync(`${work}/cuts.txt`, cuts.join("\n") + "\n");
console.log(`${p.frames.length} frames; scenes:\n${cuts.join("\n")}`);
process.exit(0);
