/** @jsxImportSource @opentui/solid */
// TEMP-REPRO: 本地复现标题/列表更新问题,不提交,诊断完删除.
// 用法: bun repro-title.tsx
import { createSignal, For, Show } from "solid-js";
import { testRender } from "@opentui/solid";

async function caseInPlaceSameSize() {
  const [n, setN] = createSignal(0);
  const t = await testRender(
    () => (
      <box>
        <text>Timeline {n()} · Alt+U</text>
      </box>
    ),
    { width: 40, height: 5 },
  );
  await t.renderOnce();
  const before = t.captureCharFrame();
  setN(6); // 同宽替换: "Timeline 0" -> "Timeline 6"
  await t.renderOnce();
  const after = t.captureCharFrame();
  const pass = after.includes("Timeline 6") && !after.includes("Timeline 0");
  console.log(`[1] in-place same-size text 0->6: ${pass ? "PASS" : "FAIL"}`);
  if (!pass) console.log("  before:", JSON.stringify(before), "\n  after:", JSON.stringify(after));
  t.renderer.destroy();
}

async function caseInPlaceWidthChange() {
  const [n, setN] = createSignal(0);
  const t = await testRender(
    () => (
      <box>
        <text>Timeline {n()}</text>
      </box>
    ),
    { width: 40, height: 5 },
  );
  await t.renderOnce();
  setN(12); // 变宽: "Timeline 0" -> "Timeline 12"
  await t.renderOnce();
  const after = t.captureCharFrame();
  const pass = after.includes("Timeline 12");
  console.log(`[2] in-place width-change text 0->12: ${pass ? "PASS" : "FAIL"}`);
  if (!pass) console.log("  after:", JSON.stringify(after));
  t.renderer.destroy();
}

async function caseShowFallback() {
  const [k, setK] = createSignal(0);
  const t = await testRender(
    () => (
      <box>
        <Show when={k() % 2 === 0} fallback={<text>odd-{k()}</text>}>
          <text>even-{k()}</text>
        </Show>
      </box>
    ),
    { width: 40, height: 5 },
  );
  await t.renderOnce();
  setK(1);
  await t.renderOnce();
  let after = t.captureCharFrame();
  const p1 = after.includes("odd-1");
  setK(2);
  await t.renderOnce();
  after = t.captureCharFrame();
  const p2 = after.includes("even-2");
  console.log(`[3] Show+fallback toggle 0->1->2: ${p1 && p2 ? "PASS" : "FAIL"} (p1=${p1} p2=${p2})`);
  if (!(p1 && p2)) console.log("  after:", JSON.stringify(after));
  t.renderer.destroy();
}

async function caseTwoShows() {
  const [k, setK] = createSignal(0);
  const t = await testRender(
    () => (
      <box>
        <Show when={k() % 2 === 0}>
          <text>even-{k()}</text>
        </Show>
        <Show when={k() % 2 !== 0}>
          <text>odd-{k()}</text>
        </Show>
      </box>
    ),
    { width: 40, height: 5 },
  );
  await t.renderOnce();
  setK(3);
  await t.renderOnce();
  const after = t.captureCharFrame();
  const pass = after.includes("odd-3") && !after.includes("even-");
  console.log(`[4] two separate Shows 0->3: ${pass ? "PASS" : "FAIL"}`);
  if (!pass) console.log("  after:", JSON.stringify(after));
  t.renderer.destroy();
}

async function caseForAppend() {
  const [items, setItems] = createSignal(["a"]);
  const t = await testRender(
    () => (
      <box>
        <For each={items()}>{(it) => <text>row-{it}</text>}</For>
      </box>
    ),
    { width: 40, height: 10 },
  );
  await t.renderOnce();
  setItems(["a", "b", "c"]);
  await t.renderOnce();
  const after = t.captureCharFrame();
  const pass = after.includes("row-c");
  console.log(`[5] For append 1->3 rows: ${pass ? "PASS" : "FAIL"}`);
  if (!pass) console.log("  after:", JSON.stringify(after));
  t.renderer.destroy();
}

async function caseForOverflowScrollbox() {
  const [items, setItems] = createSignal<string[]>([]);
  const t = await testRender(
    () => (
      <scrollbox maxHeight={8} width="100%">
        <box flexDirection="column">
          <For each={items()}>{(it) => <text>row-{it}</text>}</For>
        </box>
      </scrollbox>
    ),
    { width: 40, height: 12 },
  );
  await t.renderOnce();
  setItems(Array.from({ length: 12 }, (_, i) => String(i)));
  await t.renderOnce();
  const after = t.captureCharFrame();
  const pass = after.includes("row-0") || after.includes("row-11");
  console.log(`[6] For 0->12 rows in scrollbox(maxHeight 8): ${pass ? "PASS" : "FAIL"}`);
  if (!pass) console.log("  after:", JSON.stringify(after));
  t.renderer.destroy();
}

await caseInPlaceSameSize();
await caseInPlaceWidthChange();
await caseShowFallback();
await caseTwoShows();
await caseForAppend();
await caseForOverflowScrollbox();
console.log("done");
process.exit(0);
