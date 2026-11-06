const $ = (id) => document.getElementById(id);

function el(tag, text, cls) {
    const e = document.createElement(tag);
    if (text !== undefined) e.textContent = text;
    if (cls) e.className = cls;
    return e;
}

function cellText(rec, name) {
    if (name in rec.vars) return formatValue(rec.vars[name]);
    if (name in rec.arrays) return formatArray(rec.arrays[name]);
    return "";
}

function buildTable(trace) {
    // 登場した変数名・配列名を、最初に出てきた順に集める
    const names = [];
    for (const rec of trace) {
        for (const n of [...Object.keys(rec.vars), ...Object.keys(rec.arrays)]) {
            if (!names.includes(n)) names.push(n);
        }
    }

    const table = el("table");
    const head = el("tr");
    ["ステップ", "行", "内容", ...names].forEach((h) => head.appendChild(el("th", h)));
    table.appendChild(head);

    let prev = null;
    for (const rec of trace) {
        const tr = el("tr");
        tr.appendChild(el("td", String(rec.step)));
        tr.appendChild(el("td", rec.line ? String(rec.line) : "-"));
        tr.appendChild(el("td", rec.desc));
        for (const n of names) {
            const text = cellText(rec, n);
            const changed = prev !== null && text !== cellText(prev, n);
            tr.appendChild(el("td", text, changed ? "changed" : ""));
        }
        table.appendChild(tr);
        prev = rec;
    }
    return table;
}

$("runBtn").addEventListener("click", () => {
    const errBox = $("error");
    const area = $("trace");
    errBox.textContent = "";
    area.textContent = "";

    let result;
    try {
        const ast = parseProgram($("source").value);
        const initial = parseInitial($("initial").value);
        result = runProgram(ast, initial, { intDiv: $("divMode").value === "int" });
    } catch (e) {
        errBox.textContent = "エラー: " + e.message;
        return;
    }

    area.appendChild(buildTable(result.trace));
    if (result.error) errBox.textContent = "実行エラー: " + result.error;
});
$("pyBtn").addEventListener("click", () => {
  const errBox = $("error");
  errBox.textContent = "";
  try {
    const ast = parseProgram($("source").value);
    const initial = parseInitial($("initial").value);
    $("code").textContent = generatePython(ast, initial, { intDiv: $("divMode").value === "int" });
  } catch (e) {
    $("code").textContent = "";
    errBox.textContent = "エラー: " + e.message;
  }
});