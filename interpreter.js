const MAX_STEPS = 10000;

function fail(ctx, msg) {
    throw new Error(`${ctx.line}行目: ${msg}`);
}

function formatValue(v) {
    return String(v);
}

function formatArray(arr) {
    const keys = Object.keys(arr).map(Number).sort((a, b) => a - b);
    const contiguous = keys.every((k, i) => k === i + 1);
    if (contiguous) return "[" + keys.map((k) => formatValue(arr[k])).join(", ") + "]";
    return "{" + keys.map((k) => `${k}: ${formatValue(arr[k])}`).join(", ") + "}";
}

function needNum(ctx, v) {
    if (typeof v !== "number") fail(ctx, `数値が必要です(${formatValue(v)})`);
    return v;
}

function needBool(ctx, v) {
    if (typeof v !== "boolean") fail(ctx, `真偽値が必要です(${formatValue(v)})`);
    return v;
}

function evalIndex(node, ctx) {
    const i = evalExpr(node.index, ctx);
    if (typeof i !== "number" || !Number.isInteger(i)) {
        fail(ctx, `添字が整数ではありません(${node.name}[${formatValue(i)}])`);
    }
    return i;
}

function evalExpr(node, ctx) {
    switch (node.type) {
        case "num":
            return node.value;
        case "var":
            if (node.name === "true") return true;
            if (node.name === "false") return false;
            if (!(node.name in ctx.vars)) fail(ctx, `変数 ${node.name} が未定義です`);
            return ctx.vars[node.name];
        case "index": {
            const i = evalIndex(node, ctx);
            const arr = ctx.arrays[node.name];
            if (!arr || !(i in arr)) fail(ctx, `${node.name}[${i}] が未定義です`);
            return arr[i];
        }
        case "unary": {
            const v = evalExpr(node.operand, ctx);
            if (node.op === "-") return -needNum(ctx, v);
            if (node.op === "+") return needNum(ctx, v);
            return !needBool(ctx, v);   // not
        }
        case "binary": {
            const op = node.op;
            if (op === "and" || op === "or") {
                const l = needBool(ctx, evalExpr(node.left, ctx));
                if (op === "and" && !l) return false;   // 短絡評価
                if (op === "or" && l) return true;
                return needBool(ctx, evalExpr(node.right, ctx));
            }
            const l = evalExpr(node.left, ctx);
            const r = evalExpr(node.right, ctx);
            if (op === "=") return l === r;
            if (op === "!=") return l !== r;
            needNum(ctx, l);
            needNum(ctx, r);
            switch (op) {
                case "+": return l + r;
                case "-": return l - r;
                case "*": return l * r;
                case "/":
                    if (r === 0) fail(ctx, "0で除算しています");
                    if (ctx.intDiv && Number.isInteger(l) && Number.isInteger(r)) return Math.trunc(l / r);
                    return l / r;
                case "mod":
                    if (r === 0) fail(ctx, "0で除算しています");
                    return l % r;
                case "<": return l < r;
                case "<=": return l <= r;
                case ">": return l > r;
                case ">=": return l >= r;
            }
        }
    }
    fail(ctx, "未対応の式です");
}

function evalCond(node, ctx) {
    const v = evalExpr(node, ctx);
    if (typeof v !== "boolean") fail(ctx, `条件式が真偽値ではありません(${formatValue(v)})`);
    return v;
}

function assignTo(target, value, ctx) {
    if (target.type === "var") {
        ctx.vars[target.name] = value;
        return target.name;
    }
    const i = evalIndex(target, ctx);
    if (!ctx.arrays[target.name]) ctx.arrays[target.name] = Object.create(null);
    ctx.arrays[target.name][i] = value;
    return `${target.name}[${i}]`;
}

function snapshot(ctx) {
    const arrays = Object.create(null);
    for (const name of Object.keys(ctx.arrays)) {
        arrays[name] = Object.assign(Object.create(null), ctx.arrays[name]);
    }
    return { vars: Object.assign(Object.create(null), ctx.vars), arrays };
}

function record(ctx, desc) {
    if (ctx.trace.length > MAX_STEPS) {
        fail(ctx, `ステップ数が上限(${MAX_STEPS})を超えました。無限ループの可能性があります`);
    }
    ctx.trace.push({ step: ctx.trace.length, line: ctx.line, desc, ...snapshot(ctx) });
}

function execBlock(stmts, ctx) {
    for (const s of stmts) execStmt(s, ctx);
}

function execStmt(s, ctx) {
    ctx.line = s.line;
    switch (s.type) {
        case "assign": {
            const v = evalExpr(s.value, ctx);
            const label = assignTo(s.target, v, ctx);
            record(ctx, `${label} ← ${formatValue(v)}`);
            break;
        }
        case "if": {
            for (const br of s.branches) {
                ctx.line = br.line || s.line;
                const c = evalCond(br.cond, ctx);
                record(ctx, `条件 → ${c ? "真" : "偽"}`);
                if (c) { execBlock(br.body, ctx); return; }
            }
            if (s.elseBody) execBlock(s.elseBody, ctx);
            break;
        }
        case "while":
            while (true) {
                ctx.line = s.line;
                const c = evalCond(s.cond, ctx);
                record(ctx, `条件 → ${c ? "真" : "偽"}`);
                if (!c) break;
                execBlock(s.body, ctx);
            }
            break;
        case "doWhile":
            while (true) {
                execBlock(s.body, ctx);
                ctx.line = s.condLine || s.line;
                const c = evalCond(s.cond, ctx);
                record(ctx, `条件 → ${c ? "真" : "偽"}`);
                if (!c) break;
            }
            break;
        case "for": {
            const name = s.varName;
            const start = needNum(ctx, evalExpr(s.start, ctx));
            const end = needNum(ctx, evalExpr(s.end, ctx));
            const step = needNum(ctx, evalExpr(s.step, ctx));
            if (step <= 0) fail(ctx, "増分は正の数にしてください");
            ctx.vars[name] = start;
            record(ctx, `${name} ← ${formatValue(start)}(ループ開始)`);
            while (true) {
                ctx.line = s.line;
                const v = needNum(ctx, ctx.vars[name]);
                const cont = s.dir === "inc" ? v <= end : v >= end;
                if (!cont) {
                    record(ctx, `${name} = ${formatValue(v)} → ループ終了`);
                    break;
                }
                execBlock(s.body, ctx);
                ctx.line = s.line;
                const nv = needNum(ctx, ctx.vars[name]) + (s.dir === "inc" ? step : -step);
                ctx.vars[name] = nv;
                record(ctx, `${name} ← ${formatValue(nv)}`);
            }
            break;
        }
    }
}

// 初期値テキスト(例: n ← 4 / a ← {5, 3, 8, 1})を読む。配列の添字は1から。
function evalConst(str) {
    const ctx = { vars: Object.create(null), arrays: Object.create(null), line: 0, trace: [] };
    return evalExpr(parseExprText(str, 0), ctx);
}

function parseInitial(text) {
    const vars = Object.create(null);
    const arrays = Object.create(null);
    text.split("\n").forEach((raw, idx) => {
        const line = raw.normalize("NFKC").trim();
        if (line === "") return;
        const m = line.match(/^([A-Za-z_]\w*)\s*(?:←|<-|=)\s*(.+)$/);
        if (!m) throw new Error(`初期値 ${idx + 1}行目: 「名前 ← 値」の形で書いてください`);
        const name = m[1];
        const val = m[2].trim();
        try {
            if (val.startsWith("{") && val.endsWith("}")) {
                const arr = Object.create(null);
                const inner = val.slice(1, -1).trim();
                if (inner !== "") inner.split(",").forEach((x, k) => { arr[k + 1] = evalConst(x.trim()); });
                arrays[name] = arr;
            } else {
                vars[name] = evalConst(val);
            }
        } catch (e) {
            throw new Error(`初期値 ${idx + 1}行目: ${e.message.replace(/^\d+行目: /, "")}`);
        }
    });
    return { vars, arrays };
}

function runProgram(ast, initial, options) {
    const ctx = { vars: Object.create(null), arrays: Object.create(null), line: 0, trace: [], intDiv: !!(options && options.intDiv) };
    if (initial) {
        Object.assign(ctx.vars, initial.vars);
        for (const k of Object.keys(initial.arrays)) ctx.arrays[k] = Object.assign(Object.create(null), initial.arrays[k]);
    }
    let error = null;
    try {
        record(ctx, "初期状態");
        execBlock(ast, ctx);
    } catch (e) {
        error = e.message;
    }
    return { trace: ctx.trace, error };
}