const OPS = ["<-", "<=", ">=", "!=", "←", "≦", "≧", "≠", "×", "÷", "+", "-", "*", "/", "%", "=", "<", ">", "(", ")", "[", "]", ","];
const OP_ALIAS = { "<-": "←", "≦": "<=", "≧": ">=", "≠": "!=", "×": "*", "÷": "/" };

function tokenize(text, lineNo) {
    text = text.normalize("NFKC");   // 全角の数字・英字・括弧を半角に統一
    const tokens = [];
    let i = 0;
    while (i < text.length) {
        const ch = text[i];

        // 空白は読み飛ばす
        if (/\s/.test(ch)) { i++; continue; }

        // 数値
        if (/[0-9]/.test(ch)) {
            let j = i;
            while (j < text.length && /[0-9.]/.test(text[j])) j++;
            tokens.push({ type: "num", value: Number(text.slice(i, j)), line: lineNo });
            i = j;
            continue;
        }

        // 識別子(変数名・if や while などのキーワード)
        if (/[A-Za-z_]/.test(ch)) {
            let j = i;
            while (j < text.length && /[A-Za-z0-9_]/.test(text[j])) j++;
            tokens.push({ type: "ident", value: text.slice(i, j), line: lineNo });
            i = j;
            continue;
        }

        // 演算子(長いものを先に判定するため OPS の並びが重要)
        const op = OPS.find(o => text.startsWith(o, i));
        if (op) {
            tokens.push({ type: "op", value: OP_ALIAS[op] || op, line: lineNo });
            i += op.length;
            continue;
        }

        throw new Error(`${lineNo}行目: 認識できない文字「${ch}」`);
    }
    return tokens;
}
// ---- 式の構文解析(再帰下降) ----
const RESERVED = ["and", "or", "not", "mod", "if", "elseif", "else", "endif", "while", "endwhile", "do", "for", "endfor"];
const CMP_OPS = ["=", "!=", "<", "<=", ">", ">="];

function parseExpression(tokens) {
    let pos = 0;
    const peek = () => tokens[pos];
    const isOp = (v) => peek() && peek().type === "op" && peek().value === v;
    const isKw = (v) => peek() && peek().type === "ident" && peek().value === v;
    const lineOf = () => (peek() ? peek().line : tokens.length ? tokens[tokens.length - 1].line : 0);
    const fail = (msg) => { throw new Error(`${lineOf()}行目: ${msg}`); };

    function expectOp(v) {
        if (!isOp(v)) fail(`「${v}」が必要です`);
        pos++;
    }

    function parseOr() {
        let left = parseAnd();
        while (isKw("or")) {
            pos++;
            left = { type: "binary", op: "or", left, right: parseAnd() };
        }
        return left;
    }

    function parseAnd() {
        let left = parseCompare();
        while (isKw("and")) {
            pos++;
            left = { type: "binary", op: "and", left, right: parseCompare() };
        }
        return left;
    }

    function parseCompare() {
        const left = parseAdd();
        const t = peek();
        if (t && t.type === "op" && CMP_OPS.includes(t.value)) {
            pos++;
            return { type: "binary", op: t.value, left, right: parseAdd() };
        }
        return left;
    }

    function parseAdd() {
        let left = parseMul();
        while (isOp("+") || isOp("-")) {
            const op = peek().value;
            pos++;
            left = { type: "binary", op, left, right: parseMul() };
        }
        return left;
    }

    function parseMul() {
        let left = parseUnary();
        while (isOp("*") || isOp("/") || isOp("%") || isKw("mod")) {
            const op = (isKw("mod") || isOp("%")) ? "mod" : peek().value;
            pos++;
            left = { type: "binary", op, left, right: parseUnary() };
        }
        return left;
    }

    function parseUnary() {
        if (isOp("-") || isOp("+")) {
            const op = peek().value;
            pos++;
            return { type: "unary", op, operand: parseUnary() };
        }
        if (isKw("not")) {
            pos++;
            return { type: "unary", op: "not", operand: parseUnary() };
        }
        return parsePrimary();
    }

    function parsePrimary() {
        const t = peek();
        if (!t) fail("式が途中で終わっています");
        if (t.type === "num") {
            pos++;
            return { type: "num", value: t.value };
        }
        if (t.type === "ident") {
            if (RESERVED.includes(t.value)) fail(`「${t.value}」は式の中では使えません`);
            pos++;
            if (isOp("[")) {
                pos++;
                const index = parseOr();
                expectOp("]");
                return { type: "index", name: t.value, index };
            }
            return { type: "var", name: t.value };
        }
        if (isOp("(")) {
            pos++;
            const e = parseOr();
            expectOp(")");
            return e;
        }
        fail(`予期しない記号「${t.value}」`);
    }

    const result = parseOr();
    if (pos < tokens.length) fail(`余分な記号「${peek().value}」があります`);
    return result;
}
// ---- 行ごとの構文解析(ブロックを入れ子のASTにする) ----
function parseTokens(tokens, lineNo) {
    if (tokens.length === 0) throw new Error(`${lineNo}行目: 式が空です`);
    return parseExpression(tokens);
}

function parseExprText(str, lineNo) {
    return parseTokens(tokenize(str, lineNo), lineNo);
}

function parseProgram(source) {
    const root = [];
    const stack = [];   // 開いているブロック { kind, node, body, line }
    const top = () => stack[stack.length - 1];
    const cur = () => (stack.length ? top().body : root);

    function requireTop(kind, word, lineNo) {
        const t = top();
        if (!t) throw new Error(`${lineNo}行目: 「${word}」に対応する ${kind} がありません`);
        if (t.kind !== kind) throw new Error(`${lineNo}行目: 「${word}」の前に ${t.line}行目の ${t.kind} が閉じられていません`);
        return t;
    }

    const lines = source.split("\n");
    for (let idx = 0; idx < lines.length; idx++) {
        const lineNo = idx + 1;
        const text = lines[idx].normalize("NFKC").trim();
        if (text === "") continue;   // 空行は読み飛ばす
        let m;

        if ((m = text.match(/^if\s*\((.*)\)$/))) {
            const node = { type: "if", line: lineNo, branches: [{ cond: parseExprText(m[1], lineNo), body: [], line: lineNo }], elseBody: null };
            cur().push(node);
            stack.push({ kind: "if", node, body: node.branches[0].body, line: lineNo });

        } else if ((m = text.match(/^elseif\s*\((.*)\)$/))) {
            const t = requireTop("if", "elseif", lineNo);
            if (t.node.elseBody !== null) throw new Error(`${lineNo}行目: else の後に elseif は書けません`);
            const branch = { cond: parseExprText(m[1], lineNo), body: [], line: lineNo };
            t.node.branches.push(branch);
            t.body = branch.body;

        } else if (text === "else") {
            const t = requireTop("if", "else", lineNo);
            if (t.node.elseBody !== null) throw new Error(`${lineNo}行目: else は1つの if に1回だけです`);
            t.node.elseBody = [];
            t.body = t.node.elseBody;

        } else if (text === "endif") {
            requireTop("if", "endif", lineNo);
            stack.pop();

        } else if ((m = text.match(/^while\s*\((.*)\)$/))) {
            if (stack.length && top().kind === "do") {
                // do ... while (条件) の終端
                const t = top();
                t.node.cond = parseExprText(m[1], lineNo);
                t.node.condLine = lineNo;
                stack.pop();
            } else {
                const node = { type: "while", line: lineNo, cond: parseExprText(m[1], lineNo), body: [] };
                cur().push(node);
                stack.push({ kind: "while", node, body: node.body, line: lineNo });
            }

        } else if (text === "endwhile") {
            requireTop("while", "endwhile", lineNo);
            stack.pop();

        } else if (text === "do") {
            const node = { type: "doWhile", line: lineNo, body: [], cond: null };
            cur().push(node);
            stack.push({ kind: "do", node, body: node.body, line: lineNo });

        } else if ((m = text.match(/^for\s*\(\s*([A-Za-z_]\w*)\s*を\s*(.+?)\s*から\s*(.+?)\s*まで\s*(.+?)\s*ずつ\s*(増やす|減らす)\s*\)$/))) {
            const node = {
                type: "for", line: lineNo, varName: m[1],
                start: parseExprText(m[2], lineNo),
                end: parseExprText(m[3], lineNo),
                step: parseExprText(m[4], lineNo),
                dir: m[5] === "増やす" ? "inc" : "dec",
                body: [],
            };
            cur().push(node);
            stack.push({ kind: "for", node, body: node.body, line: lineNo });

        } else if (text === "endfor") {
            requireTop("for", "endfor", lineNo);
            stack.pop();

        } else {
            // 代入文: 左辺 ← 右辺
            const tokens = tokenize(text, lineNo);
            const k = tokens.findIndex((t) => t.type === "op" && t.value === "←");
            if (k === -1) throw new Error(`${lineNo}行目: 認識できない行です`);
            const target = parseTokens(tokens.slice(0, k), lineNo);
            if (target.type !== "var" && target.type !== "index") {
                throw new Error(`${lineNo}行目: 代入先は変数か配列の要素にしてください`);
            }
            const value = parseTokens(tokens.slice(k + 1), lineNo);
            cur().push({ type: "assign", line: lineNo, target, value });
        }
    }

    if (stack.length) {
        const t = top();
        throw new Error(`${t.line}行目の ${t.kind} が閉じられていません`);
    }
    return root;
}