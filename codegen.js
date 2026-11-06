// ---- コード生成(Python) ----
const PY_KEYWORDS = new Set([
    "False", "None", "True", "and", "as", "assert", "async", "await", "break", "class", "continue",
    "def", "del", "elif", "else", "except", "finally", "for", "from", "global", "if", "import", "in",
    "is", "lambda", "nonlocal", "not", "or", "pass", "raise", "return", "try", "while", "with", "yield",
]);

const PY_ARRAY_PROVISIONAL_SIZE = 100;   // 初期値欄にない配列の仮の要素数

function pyName(name) {
    return PY_KEYWORDS.has(name) ? name + "_" : name;
}

function pyLiteral(v) {
    if (v === true) return "True";
    if (v === false) return "False";
    return String(v);
}

// AST内を再帰的にたどり、条件に合うノードがあるか調べる
function astSome(node, pred) {
    if (Array.isArray(node)) return node.some((n) => astSome(n, pred));
    if (node && typeof node === "object") {
        if (pred(node)) return true;
        return Object.keys(node).some((k) => astSome(node[k], pred));
    }
    return false;
}

function collectArrayNames(node, set) {
    if (Array.isArray(node)) {
        node.forEach((n) => collectArrayNames(n, set));
    } else if (node && typeof node === "object") {
        if (node.type === "index") set.add(node.name);
        Object.keys(node).forEach((k) => collectArrayNames(node[k], set));
    }
    return set;
}

function generatePython(ast, initial, options) {
    const intDiv = !!(options && options.intDiv);
    let usesDiv = false;

    const PY_OPS = {
        "=": "==", "!=": "!=", "<": "<", "<=": "<=", ">": ">", ">=": ">=",
        "+": "+", "-": "-", "*": "*", "/": "/", "mod": "%", "and": "and", "or": "or"
    };

    // Python での演算子の強さ(大きいほど強い)
    function prec(node) {
        if (node.type === "binary") {
            switch (node.op) {
                case "or": return 1;
                case "and": return 2;
                case "=": case "!=": case "<": case "<=": case ">": case ">=": return 4;
                case "+": case "-": return 6;
                case "/": return intDiv ? 10 : 7;   // 整数除算は _div(...) の関数呼び出しになる
                default: return 7;                   // * mod
            }
        }
        if (node.type === "unary") return node.op === "not" ? 3 : 8;
        return 10;
    }

    function expr(node, parentPrec, isRight) {
        const own = prec(node);
        let text;
        switch (node.type) {
            case "num":
                text = String(node.value);
                break;
            case "var":
                text = node.name === "true" ? "True" : node.name === "false" ? "False" : pyName(node.name);
                break;
            case "index":
                text = `${pyName(node.name)}[${expr(node.index, 0, false)}]`;
                break;
            case "unary":
                text = node.op === "not"
                    ? "not " + expr(node.operand, 10, false)    // not の対象は読みやすさのため括弧で囲む
                    : node.op + expr(node.operand, 9, false);
                break;
            case "binary":
                if (node.op === "/" && intDiv) {
                    usesDiv = true;
                    text = `_div(${expr(node.left, 0, false)}, ${expr(node.right, 0, false)})`;
                } else {
                    text = `${expr(node.left, own, false)} ${PY_OPS[node.op]} ${expr(node.right, own, true)}`;
                }
                break;
        }
        const wrap = own < parentPrec || (own === parentPrec && (isRight || own === 4));
        return wrap ? `(${text})` : text;
    }

    const top = (node) => expr(node, 0, false);
    const IND = "    ";

    // 式に定数 k を足した式を作る(range の終端用)。「n - 1 + 1」のようにならないよう整理する
    function plusConst(node, k) {
        if (node.type === "num") return { type: "num", value: node.value + k };
        if (node.type === "binary" && (node.op === "+" || node.op === "-") && node.right.type === "num") {
            const c = (node.op === "+" ? node.right.value : -node.right.value) + k;
            if (c === 0) return node.left;
            return { type: "binary", op: c > 0 ? "+" : "-", left: node.left, right: { type: "num", value: Math.abs(c) } };
        }
        return { type: "binary", op: k > 0 ? "+" : "-", left: node, right: { type: "num", value: Math.abs(k) } };
    }

    function negate(node) {
        if (node.type === "num") return { type: "num", value: -node.value };
        return { type: "unary", op: "-", operand: node };
    }

    function block(stmts, depth) {
        if (stmts.length === 0) return [IND.repeat(depth) + "pass"];
        const lines = [];
        for (const s of stmts) lines.push(...stmt(s, depth));
        return lines;
    }

    function stmt(s, depth) {
        const pad = IND.repeat(depth);
        switch (s.type) {
            case "assign":
                return [`${pad}${top(s.target)} = ${top(s.value)}`];
            case "if": {
                const lines = [];
                s.branches.forEach((br, idx) => {
                    lines.push(`${pad}${idx === 0 ? "if" : "elif"} ${top(br.cond)}:`);
                    lines.push(...block(br.body, depth + 1));
                });
                if (s.elseBody) {
                    lines.push(`${pad}else:`);
                    lines.push(...block(s.elseBody, depth + 1));
                }
                return lines;
            }
            case "while":
                return [`${pad}while ${top(s.cond)}:`, ...block(s.body, depth + 1)];
            case "doWhile":
                return [
                    `${pad}while True:`,
                    ...block(s.body, depth + 1),
                    `${pad}${IND}if ${top({ type: "unary", op: "not", operand: s.cond })}:`,
                    `${pad}${IND}${IND}break`,
                ];
            case "for": {
                const v = pyName(s.varName);
                const inc = s.dir === "inc";
                const modifiesVar = astSome(s.body, (n) =>
                    (n.type === "assign" && n.target.type === "var" && n.target.name === s.varName) ||
                    (n.type === "for" && n.varName === s.varName));
                if (modifiesVar) {
                    // ループ変数を本体で書き換えるため、range ではなく while で表す
                    return [
                        `${pad}${v} = ${top(s.start)}`,
                        `${pad}while ${v} ${inc ? "<=" : ">="} ${top(s.end)}:`,
                        ...block(s.body, depth + 1),
                        `${pad}${IND}${v} ${inc ? "+=" : "-="} ${top(s.step)}`,
                    ];
                }
                const isOne = s.step.type === "num" && s.step.value === 1;
                const args = [top(s.start), top(plusConst(s.end, inc ? 1 : -1))];
                if (inc && !isOne) args.push(top(s.step));
                if (!inc) args.push(top(negate(s.step)));
                return [`${pad}for ${v} in range(${args.join(", ")}):`, ...block(s.body, depth + 1)];
            }
        }
        return [`${pad}# 未対応の文`];
    }

    // 初期値欄の内容と、配列の宣言
    const head = [];
    const initVars = initial ? Object.keys(initial.vars) : [];
    const initArrays = initial ? Object.keys(initial.arrays) : [];
    for (const name of initVars) head.push(`${pyName(name)} = ${pyLiteral(initial.vars[name])}`);
    for (const name of initArrays) {
        const arr = initial.arrays[name];
        const n = Object.keys(arr).length;
        const items = ["0"];   // 0番目は未使用
        for (let k = 1; k <= n; k++) items.push(pyLiteral(arr[k]));
        head.push(`${pyName(name)} = [${items.join(", ")}]   # 要素番号1〜${n}を使用(0番目は未使用)`);
    }
    for (const name of collectArrayNames(ast, new Set())) {
        if (initArrays.includes(name)) continue;
        head.push(`${pyName(name)} = [0] * ${PY_ARRAY_PROVISIONAL_SIZE + 1}   # 要素数は仮(1〜${PY_ARRAY_PROVISIONAL_SIZE})。必要に応じて変更`);
    }

    const body = block(ast, 0);

    const out = [];
    if (usesDiv) {
        out.push(
            "def _div(a, b):",
            "    # 疑似言語の ÷ : 整数同士は商(0方向への切り捨て)、それ以外は実数の除算",
            "    if isinstance(a, int) and isinstance(b, int):",
            "        q = abs(a) // abs(b)",
            "        return q if (a >= 0) == (b >= 0) else -q",
            "    return a / b",
            "", "",
        );
    }
    if (head.length) out.push(...head, "");
    out.push(...body);
    return out.join("\n") + "\n";
}

// ---- コード生成(Java) ----
const JAVA_KEYWORDS = new Set([
  "abstract", "assert", "boolean", "break", "byte", "case", "catch", "char", "class", "const",
  "continue", "default", "do", "double", "else", "enum", "extends", "final", "finally", "float",
  "for", "goto", "if", "implements", "import", "instanceof", "int", "interface", "long", "native",
  "new", "package", "private", "protected", "public", "return", "short", "static", "strictfp",
  "super", "switch", "synchronized", "this", "throw", "throws", "transient", "try", "void",
  "volatile", "while", "true", "false", "null", "args",   // args は main の引数名と衝突するため
]);

function javaName(name) {
  return JAVA_KEYWORDS.has(name) ? name + "_" : name;
}

function javaLiteral(v) {
  if (v === true) return "true";
  if (v === false) return "false";
  return String(v);
}

function joinType(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (a === "conflict" || b === "conflict") return "conflict";
  if (a === b) return a;
  if ((a === "int" && b === "double") || (a === "double" && b === "int")) return "double";
  return "conflict";
}

// 変数・配列の型(int / double / boolean)を、代入される値から推定する
function inferTypes(ast, initial, intDiv) {
  const vars = Object.create(null);
  const arrays = Object.create(null);
  const litType = (v) => (typeof v === "boolean" ? "boolean" : Number.isInteger(v) ? "int" : "double");
  if (initial) {
    for (const k of Object.keys(initial.vars)) vars[k] = litType(initial.vars[k]);
    for (const k of Object.keys(initial.arrays)) {
      let t;
      for (const v of Object.values(initial.arrays[k])) t = joinType(t, litType(v));
      arrays[k] = t;
    }
  }

  function typeOf(node) {
    switch (node.type) {
      case "num": return Number.isInteger(node.value) ? "int" : "double";
      case "var":
        if (node.name === "true" || node.name === "false") return "boolean";
        return vars[node.name];
      case "index": return arrays[node.name];
      case "unary": {
        if (node.op === "not") return "boolean";
        const t = typeOf(node.operand);
        return t === "boolean" ? "conflict" : t;
      }
      case "binary": {
        const op = node.op;
        if (["and", "or", "=", "!=", "<", "<=", ">", ">="].includes(op)) return "boolean";
        const l = typeOf(node.left);
        const r = typeOf(node.right);
        if (l === "conflict" || r === "conflict" || l === "boolean" || r === "boolean") return "conflict";
        if (!l && !r) return undefined;
        const bothInt = (l || "int") === "int" && (r || "int") === "int";   // 未確定の側は int と仮定(後の反復で補正)
        if (op === "/") return intDiv ? (bothInt ? "int" : "double") : "double";
        return bothInt ? "int" : "double";   // + - * mod
      }
    }
    return undefined;
  }

  let changed = true;
  const upd = (map, name, t) => {
    if (!t) return;
    const nt = joinType(map[name], t);
    if (nt !== map[name]) { map[name] = nt; changed = true; }
  };
  function visit(stmts) {
    for (const s of stmts) {
      switch (s.type) {
        case "assign":
          if (s.target.type === "var") upd(vars, s.target.name, typeOf(s.value));
          else upd(arrays, s.target.name, typeOf(s.value));
          break;
        case "if":
          s.branches.forEach((b) => visit(b.body));
          if (s.elseBody) visit(s.elseBody);
          break;
        case "while": case "doWhile":
          visit(s.body);
          break;
        case "for":
          upd(vars, s.varName, joinType(typeOf(s.start), typeOf(s.step)) || "int");
          visit(s.body);
          break;
      }
    }
  }
  for (let guard = 0; changed && guard < 50; guard++) {
    changed = false;
    visit(ast);
  }
  return { vars, arrays, typeOf };
}

// name が「それを制御変数とする for の外」で使われているか(使われていれば for の中だけの変数にできない)
function usedOutsideItsLoop(ast, name) {
  let outside = false;
  function walk(node, inside) {
    if (outside) return;
    if (Array.isArray(node)) { node.forEach((n) => walk(n, inside)); return; }
    if (!node || typeof node !== "object") return;
    if (node.type === "for" && node.varName === name) {
      if (inside) { outside = true; return; }   // 同じ変数の for が入れ子になっている
      walk(node.start, inside);
      walk(node.end, inside);
      walk(node.step, inside);
      walk(node.body, true);
      return;
    }
    if (!inside && node.type === "var" && node.name === name) outside = true;
    Object.keys(node).forEach((k) => walk(node[k], inside));
  }
  walk(ast, false);
  return outside;
}

function collectNames(node, vars, loops) {
  if (Array.isArray(node)) {
    node.forEach((n) => collectNames(n, vars, loops));
  } else if (node && typeof node === "object") {
    if (node.type === "var" && node.name !== "true" && node.name !== "false") vars.add(node.name);
    if (node.type === "for") loops.add(node.varName);
    Object.keys(node).forEach((k) => collectNames(node[k], vars, loops));
  }
}

function generateJava(ast, initial, options) {
  const intDiv = !!(options && options.intDiv);
  const types = inferTypes(ast, initial, intDiv);
  for (const [label, map] of [["変数", types.vars], ["配列", types.arrays]]) {
    for (const k of Object.keys(map)) {
      if (map[k] === "conflict") throw new Error(`${label} ${k} の型を決められません(数値と真偽値が混ざっています)`);
    }
  }
  const typeOf = types.typeOf;
  const varType = (name) => types.vars[name] || "int";
  const arrType = (name) => types.arrays[name] || "int";

  // 変数を分類する
  const used = new Set();
  const loops = new Set();
  collectNames(ast, used, loops);
  const initVars = initial ? Object.keys(initial.vars) : [];
  const initArrays = initial ? Object.keys(initial.arrays) : [];
  const localLoopVars = new Set([...loops].filter((n) => !initVars.includes(n) && !usedOutsideItsLoop(ast, n)));
  const inPlace = new Set();   // 最初の代入と同時に宣言する文
  const hoisted = [];          // 先頭でまとめて宣言する変数
  for (const name of used) {
    if (initVars.includes(name) || localLoopVars.has(name)) continue;
    const idx = ast.findIndex((st) => astSome(st, (n) =>
      (n.type === "var" && n.name === name) || (n.type === "for" && n.varName === name)));
    const st = ast[idx];
    if (st && st.type === "assign" && st.target.type === "var" && st.target.name === name &&
        !astSome(st.value, (n) => n.type === "var" && n.name === name)) {
      inPlace.add(st);
    } else {
      hoisted.push(name);
    }
  }
  for (const name of loops) {
    if (!localLoopVars.has(name) && !initVars.includes(name) && !used.has(name) && !hoisted.includes(name)) hoisted.push(name);
  }

  function prec(node) {
    if (node.type === "binary") {
      switch (node.op) {
        case "or": return 1;
        case "and": return 2;
        case "=": case "!=": case "<": case "<=": case ">": case ">=": return 4;
        case "+": case "-": return 6;
        default: return 7;   // * / mod
      }
    }
    if (node.type === "unary") return 8;
    return 10;
  }

  const JAVA_OPS = { "=": "==", "!=": "!=", "<": "<", "<=": "<=", ">": ">", ">=": ">=",
    "+": "+", "-": "-", "*": "*", "/": "/", "mod": "%", "and": "&&", "or": "||" };

  function expr(node, parentPrec, isRight) {
    const own = prec(node);
    let text;
    switch (node.type) {
      case "num":
        text = String(node.value);
        break;
      case "var":
        text = node.name === "true" || node.name === "false" ? node.name : javaName(node.name);
        break;
      case "index":
        text = `${javaName(node.name)}[${expr(node.index, 0, false)}]`;
        break;
      case "unary":
        text = node.op === "not"
          ? "!" + expr(node.operand, 10, false)
          : node.op + expr(node.operand, 9, false);
        break;
      case "binary": {
        const needCast = node.op === "/" && !intDiv &&
          typeOf(node.left) !== "double" && typeOf(node.right) !== "double";
        const l = needCast ? "(double) " + expr(node.left, 9, false) : expr(node.left, own, false);
        text = `${l} ${JAVA_OPS[node.op]} ${expr(node.right, own, true)}`;
        break;
      }
    }
    const wrap = own < parentPrec || (own === parentPrec && (isRight || own === 4));
    return wrap ? `(${text})` : text;
  }

  const top = (node) => expr(node, 0, false);
  const IND = "    ";

  function block(stmts, depth) {
    const lines = [];
    for (const s of stmts) lines.push(...stmt(s, depth));
    return lines;
  }

  function stmt(s, depth) {
    const pad = IND.repeat(depth);
    switch (s.type) {
      case "assign": {
        const decl = inPlace.has(s) ? `${varType(s.target.name)} ` : "";
        return [`${pad}${decl}${top(s.target)} = ${top(s.value)};`];
      }
      case "if": {
        const lines = [];
        s.branches.forEach((br, idx) => {
          lines.push(idx === 0 ? `${pad}if (${top(br.cond)}) {` : `${pad}} else if (${top(br.cond)}) {`);
          lines.push(...block(br.body, depth + 1));
        });
        if (s.elseBody) {
          lines.push(`${pad}} else {`);
          lines.push(...block(s.elseBody, depth + 1));
        }
        lines.push(`${pad}}`);
        return lines;
      }
      case "while":
        return [`${pad}while (${top(s.cond)}) {`, ...block(s.body, depth + 1), `${pad}}`];
      case "doWhile":
        return [`${pad}do {`, ...block(s.body, depth + 1), `${pad}} while (${top(s.cond)});`];
      case "for": {
        const v = javaName(s.varName);
        const inc = s.dir === "inc";
        const decl = localLoopVars.has(s.varName) ? `${varType(s.varName)} ` : "";
        const stepOne = s.step.type === "num" && s.step.value === 1;
        const update = stepOne ? `${v}${inc ? "++" : "--"}` : `${v} ${inc ? "+=" : "-="} ${top(s.step)}`;
        return [
          `${pad}for (${decl}${v} = ${top(s.start)}; ${v} ${inc ? "<=" : ">="} ${top(s.end)}; ${update}) {`,
          ...block(s.body, depth + 1),
          `${pad}}`,
        ];
      }
    }
    return [`${pad}// 未対応の文`];
  }

  // 先頭の宣言(初期値欄の内容・配列・先頭でまとめて宣言する変数)
  const pad2 = IND.repeat(2);
  const zero = { int: "0", double: "0.0", boolean: "false" };
  const head = [];
  for (const name of initVars) head.push(`${pad2}${varType(name)} ${javaName(name)} = ${javaLiteral(initial.vars[name])};`);
  for (const name of initArrays) {
    const arr = initial.arrays[name];
    const n = Object.keys(arr).length;
    const t = arrType(name);
    const items = [zero[t]];   // 0番目は未使用
    for (let k = 1; k <= n; k++) items.push(javaLiteral(arr[k]));
    head.push(`${pad2}${t}[] ${javaName(name)} = {${items.join(", ")}};   // 要素番号1〜${n}を使用(0番目は未使用)`);
  }
  for (const name of collectArrayNames(ast, new Set())) {
    if (initArrays.includes(name)) continue;
    head.push(`${pad2}${arrType(name)}[] ${javaName(name)} = new ${arrType(name)}[${PY_ARRAY_PROVISIONAL_SIZE + 1}];   // 要素数は仮(1〜${PY_ARRAY_PROVISIONAL_SIZE})。必要に応じて変更`);
  }
  for (const name of hoisted) head.push(`${pad2}${varType(name)} ${javaName(name)} = ${zero[varType(name)]};`);

  const out = ["public class Main {", `${IND}public static void main(String[] args) {`];
  if (head.length) out.push(...head, "");
  out.push(...block(ast, 2));
  out.push(`${IND}}`, "}");
  return out.join("\n") + "\n";
}