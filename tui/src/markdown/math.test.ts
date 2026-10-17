import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { termWidth } from "../textwidth";
import { joinLogicalLines } from "../historycursor";
import corpus from "./fixtures/math-corpus.json";
import { MATH_CASES } from "./fixtures/math-cases";
import {
  convertLatexMath,
  extractDisplayMath,
  findMathFragments,
  renderDisplayMath,
  renderInlineMath,
  renderInlineMathChunks,
  takeDisplayMathBlock,
} from "./math";
import { setCombiningMarksSupported } from "./mathlayout";
import { markdownWordWrap } from "./wordwrap";

// Accent rendering depends on the terminal (TERM); pin it for determinism.
beforeAll(() => setCombiningMarksSupported(true));
afterAll(() => setCombiningMarksSupported(!/^st(?:-|$)/.test(process.env.TERM ?? "")));

const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
const plainRows = (markdown: string, width: number) =>
  markdownWordWrap(markdown, width, "\x1b[0m").lines.map(line => stripAnsi(line).replace(/\u00A0/g, " "));

describe("inline TeX conversion", () => {
  const cases: Array<[string, string]> = [
    // Brace-less arguments follow TeX: one token per argument.
    [String.raw`\frac12`, "½"],
    [String.raw`\frac{1}2`, "½"],
    [String.raw`\frac1{2}`, "½"],
    [String.raw`\frac ab`, "a/b"],
    [String.raw`\frac\pi2`, "π/2"],
    [String.raw`\frac123`, "½3"],
    [String.raw`\sqrt2`, "√2"],
    [String.raw`\sqrt x`, "√x"],
    [String.raw`x^23`, "x²3"],
    [String.raw`x_ij`, "xᵢj"],
    [String.raw`x_{ij}`, "xᵢⱼ"],
    // Fractions: vulgar glyphs for simple digit pairs, parentheses where precedence needs them.
    [String.raw`\frac{3}{4}+\tfrac{2}{3}`, "¾ + ⅔"],
    [String.raw`\frac{7}{12}`, "7/12"],
    [String.raw`\frac{a+b}{c}`, "(a + b)/c"],
    [String.raw`\frac{1}{2\pi}`, "1/(2π)"],
    [String.raw`C\frac{A}{T}`, "C(A/T)"],
    [String.raw`\frac{x}{y}^2`, "(x/y)²"],
    [String.raw`\left(\frac{v-s}{v}\right)^2\times\text{size}`, "((v − s)/v)² × size"],
    [String.raw`\frac{q}{\max(1,L)}`, "q/max(1, L)"],
    [String.raw`\frac{\max(1,L)}{q}`, "max(1, L)/q"],
    [String.raw`\frac{QK^\top}{\sqrt{d_k}}`, "QKᵀ/√dₖ"],
    [String.raw`\frac{\frac{a}{b}}{c}`, "(a/b)/c"],
    // The owner's example.
    [String.raw`PS=\frac12 Q(P-10)=\frac12(229/3)^2\approx\boxed{2913.39}`, "PS = ½Q(P − 10) = ½(229/3)² ≈ 2913.39"],
    // Operators, relations and spacing.
    [String.raw`a\cdot b\times c\div d`, "a · b × c ÷ d"],
    [String.raw`x\approx y\le z\ge w\neq v`, "x ≈ y ≤ z ≥ w ≠ v"],
    [String.raw`-x+(-1)-a`, "−x + (−1) − a"],
    [String.raw`\pm 1,\ \mp 2`, "±1, ∓2"],
    [String.raw`f\colon A\to B`, "f: A → B"],
    [String.raw`P\Rightarrow Q\iff R\implies S`, "P ⇒ Q ⇔ R ⇒ S"],
    [String.raw`\neg(P\land Q)\iff(\neg P\lor\neg Q)`, "¬(P ∧ Q) ⇔ (¬P ∨ ¬Q)"],
    [String.raw`\forall x\,\exists y`, "∀x ∃y"],
    [String.raw`1,000 + 1{,}5 + f(1,2)`, "1,000 + 1,5 + f(1, 2)"],
    [String.raw`1,2,\dots,n`, "1, 2, …, n"],
    [String.raw`x_1+\cdots+x_n`, "x₁ + ⋯ + xₙ"],
    [String.raw`n! \quad f'(x) \quad f''(x) \quad 90^\circ`, "n!  f′(x)  f″(x)  90°"],
    [String.raw`x\not\in A,\ a\not= b,\ A\not\subset B`, "x ∉ A, a ≠ b, A ⊄ B"],
    [String.raw`a\equiv b\pmod n`, "a ≡ b (mod n)"],
    [String.raw`a \bmod n`, "a mod n"],
    [String.raw`2*3`, "2 × 3"],
    [String.raw`x^*`, "x∗"],
    [String.raw`\infty`, "∞"],
    // Large operators and limits.
    [String.raw`\sum_{i=1}^n x_i`, "∑ᵢ₌₁ⁿ xᵢ"],
    [String.raw`\prod_{k=1}^{N} k`, "∏ₖ₌₁ᴺ k"],
    [String.raw`\int_0^1 x^2\,dx`, "∫₀¹ x² dx"],
    [String.raw`\lim_{x\to a}e^{f(x)}=e^L`, "lim_(x→a) eᶠ⁽ˣ⁾ = eᴸ"],
    [String.raw`\lim_{x\to0}\frac{\sin x}{x}=1`, "lim_(x→0) (sin x)/x = 1"],
    [String.raw`\max_{i} a_i`, "maxᵢ aᵢ"],
    [String.raw`\lim\limits_{n\to\infty} a_n`, "lim_(n→∞) aₙ"],
    // Text, fonts and accents.
    [String.raw`\text{if } x>0`, "if x > 0"],
    [String.raw`\mathrm{d}x`, "dx"],
    [String.raw`\operatorname{rank}(A)`, "rank(A)"],
    [String.raw`\mathbb{R}^n, \mathbb N, \mathcal{L}, \mathbf{v}, \boldsymbol\beta`, "ℝⁿ, ℕ, ℒ, v, β"],
    [String.raw`\lambda_{\text{extra}}(t)`, "λ_extra(t)"],
    [String.raw`E_{\mathrm{net},30}`, "E_(net,30)"],
    [String.raw`\hat\theta + \bar{x} + \vec v + \overline{AB}`, "θ̂ + x̄ + v⃗ + A̅B̅"],
    // Scripts without Unicode forms.
    [String.raw`u^{0.2547}`, "u^0.2547"],
    [String.raw`e^{1.691x(t)}`, "e^(1.691x(t))"],
    [String.raw`e^{i\pi}+1=0`, "e^(iπ) + 1 = 0"],
    [String.raw`W_i^Q + K^\top + A^{-1}`, "Wᵢ^Q + Kᵀ + A⁻¹"],
    [String.raw`x^{y_1+\alpha}`, "x^(y₁+α)"],
    [String.raw`K_q=C_qH`, "K_q = C_q H"],
    // Roots.
    [String.raw`\sqrt{x+1} + \sqrt[3]{y} + \sqrt[n]{z} + \sqrt[k+1]{w}`, "√(x + 1) + ∛y + ⁿ√z + ᵏ⁺¹√w"],
    // Environments inline.
    [String.raw`\begin{pmatrix}a&b\\c&d\end{pmatrix}`, "(a, b; c, d)"],
    [String.raw`|x|=\begin{cases}x,&x\ge0\\-x,&x<0\end{cases}`, "|x| = {x, x ≥ 0; −x, x < 0}"],
    [String.raw`\binom{n}{k}`, "C(n, k)"],
    [String.raw`{n \choose k} + {a \over b}`, "C(n, k) + a/b"],
    // Prose in math mode keeps its word spacing.
    // (Bun exposes non-ASCII in String.raw as \u escapes, so the dash is concatenated.)
    [String.raw`\approx 4\text{` + "–" + String.raw`}9 hours for one PushT-scale run`, "≈ 4–9 hours for one PushT-scale run"],
    // Unknown commands and malformed input degrade without raw TeX.
    [String.raw`x+\unknown{y}`, "x + unknown y"],
    [String.raw`\frac{1}{`, "1"],
    [String.raw`x^{`, "x"],
    [String.raw`e^{f(x)`, "eᶠ⁽ˣ⁾"],
    [String.raw`\left(\frac12\right.`, "(½"],
    [String.raw`\color{red}{x}+\textcolor{blue}{y}`, "x + y"],
    [String.raw`\label{eq:1}x=1\tag{3}`, "x = 1  (3)"],
    [String.raw`}}x{{`, "x"],
  ];

  for (const [source, expected] of cases) {
    test(source, () => expect(convertLatexMath(source)).toBe(expected));
  }

  test("writes accents out where the terminal cannot draw combining marks", () => {
    const source = String.raw`\hat\theta + \bar{x} + \vec v + \overline{AB} + \tilde{n} + \hat{a}`;
    setCombiningMarksSupported(false);
    try {
      // Precomposed letters (ñ, â) still render as one glyph.
      expect(convertLatexMath(source)).toBe("hat(θ) + bar(x) + vec(v) + bar(AB) + ñ + â");
    } finally {
      setCombiningMarksSupported(true);
    }
  });

  test("never throws or leaks parser internals on hostile input", () => {
    for (const source of [
      "x^{".repeat(200), "\\frac{{{{", "\\left(".repeat(100), "\\begin{pmatrix}".repeat(50),
      "{".repeat(500), "\\".repeat(99), "^_^_^_", "\\sqrt[", "\\begin{cases}a&b\\\\", "\\end{aligned}x",
    ]) {
      const rendered = convertLatexMath(source);
      expect(rendered).not.toMatch(/[\uE000-\uF8FF]/);
      expect(() => convertLatexMath(source, true)).not.toThrow();
    }
  });
});

describe("display TeX layout", () => {
  test("stacks fractions and grows delimiters around them", () => {
    expect(convertLatexMath(String.raw`PS=\frac12\left(\frac{229}{3}\right)^2\approx\boxed{2913.39}`, true).split("\n")).toEqual([
      "      ⎛ 229 ⎞²   ┌─────────┐",
      "PS = ½⎜ ─── ⎟  ≈ │ 2913.39 │",
      "      ⎝  3  ⎠    └─────────┘",
    ]);
    expect(convertLatexMath(String.raw`\text{softmax}\left(\frac{QK^\top}{\sqrt{d_k}}\right)V`, true).split("\n")).toEqual([
      "       ⎛ QKᵀ ⎞",
      "softmax⎜ ─── ⎟V",
      "       ⎝ √dₖ ⎠",
    ]);
  });

  test("breaks between equations separated by \\qquad before breaking inside one", () => {
    const rendered = renderDisplayMath(String.raw`u=\frac{q}{\max(1,L)},\qquad P(\text{maker response})=\frac{u^{0.25}}{u^{0.25}+0.42\max(1,a)^{0.30}}`, 44);
    expect(rendered.lines).toEqual([
      "  u = q/max(1, L),",
      "    P(maker response)",
      "    = u^0.25/(u^0.25 + 0.42 max(1, a)^0.30)",
    ]);
  });

  test("puts limits above and below large operators", () => {
    expect(convertLatexMath(String.raw`\sum_{i=1}^{n} i = \frac{n(n+1)}{2}`, true).split("\n")).toEqual([
      " n      n(n + 1)",
      " ∑  i = ────────",
      "i=1        2",
    ]);
    expect(convertLatexMath(String.raw`\lim_{n\to\infty}\left(1+\frac{1}{n}\right)^n = e`, true).split("\n")).toEqual([
      "    ⎛     1 ⎞ⁿ",
      "lim ⎜ 1 + ─ ⎟  = e",
      "n→∞ ⎝     n ⎠",
    ]);
  });

  test("aligns environments", () => {
    expect(convertLatexMath(String.raw`f(x)=\begin{cases}x^2, & x \ge 0,\\-x, & x < 0.\end{cases}`, true).split("\n")).toEqual([
      "f(x) = ⎧ x²,  x ≥ 0,",
      "       ⎩ −x,  x < 0.",
    ]);
    expect(convertLatexMath(String.raw`A=\begin{pmatrix}1 & 2\\ 3 & 4\end{pmatrix},\quad B=\begin{bmatrix}a & b & c\\ d & e & f\end{bmatrix}`, true).split("\n")).toEqual([
      "A = ⎛ 1  2 ⎞,  B = ⎡ a  b  c ⎤",
      "    ⎝ 3  4 ⎠       ⎣ d  e  f ⎦",
    ]);
    expect(convertLatexMath(String.raw`\begin{aligned}f(x) &= x^2 + 2x + 1 \\ &= (x+1)^2\end{aligned}`, true).split("\n")).toEqual([
      "f(x) = x² + 2x + 1",
      "     = (x + 1)²",
    ]);
    expect(convertLatexMath(String.raw`\begin{array}{lr}a & bb\\ ccc & d\end{array}`, true).split("\n")).toEqual([
      "a    bb",
      "ccc   d",
    ]);
  });

  test("collapses pretty-printed source and keeps top-level rows", () => {
    expect(convertLatexMath(String.raw`\forall x\exists y\Big(
      (y\times y\times y=x)
      \land
      \forall z\big((z\times z\times z=x)\Rightarrow(z=y)\big)
    \Big).`, true)).toBe("∀x∃y((y × y × y = x) ∧ ∀z((z × z × z = x) ⇒ (z = y))).");
    expect(convertLatexMath(String.raw`a = 1 \\ b = 22`, true)).toBe("a = 1\nb = 22");
  });

  test("falls back to a linear layout broken before relations when too wide", () => {
    const source = String.raw`E_{\mathrm{net}} = E[R_{\text{durable}} + \text{bid-mark/spread P\&L}] - E[\text{fill}\times\text{unwind loss}] - \text{fill-uncertainty reserve}`;
    const rendered = renderDisplayMath(source, 50);
    expect(rendered.lines).toEqual([
      "  E_net = E[R_durable + bid-mark/spread P&L]",
      "    − E[fill × unwind loss]",
      "    − fill-uncertainty reserve",
    ]);
    expect(rendered.lines.every(line => termWidth(line) <= 50)).toBe(true);
    const fraction = renderDisplayMath(String.raw`u=\frac{q}{\max(1,L)}+\frac{u^{0.2547}}{u^{0.2547}+0.4237\max(1,a)^{0.3033}}`, 40);
    expect(fraction.lines.every(line => termWidth(line) <= 40)).toBe(true);
    expect(fraction.lines[0]).toStartWith("  u = q/max(1, L) +");
  });
});

describe("math fragments", () => {
  test("finds every delimiter style with exact source ranges", () => {
    const text = String.raw`Inline $x^2$ and \(y\), display $$a$$ and \[b\] and
\begin{align}
c &= d
\end{align}`;
    const fragments = findMathFragments(text);
    expect(fragments.map(fragment => [fragment.delimiter, fragment.display, fragment.tex, text.slice(fragment.start, fragment.end)])).toEqual([
      ["$", false, "x^2", "$x^2$"],
      ["\\(", false, "y", String.raw`\(y\)`],
      ["$$", true, "a", "$$a$$"],
      ["\\[", true, "b", String.raw`\[b\]`],
      ["env", true, "\\begin{align}\nc &= d\n\\end{align}", "\\begin{align}\nc &= d\n\\end{align}"],
    ]);
  });

  test("skips code, prices, escapes and shell variables", () => {
    const text = [
      "It costs $5 and at most $10; **$100k** and **$60k**; $5-$10, $20/$30.",
      "Escaped \\$5 and \\$x$ stay text; `$x$` and ``\\(y\\)`` are code.",
      "Shell PATH=\"$JAVA_HOME/bin:$PATH\" and US$5 are not math.",
      "```",
      "$$z$$ \\[w\\]",
      "```",
      "Real: $n$th term.",
    ].join("\n");
    expect(findMathFragments(text).map(fragment => fragment.tex)).toEqual(["n"]);
  });

  test("strips blockquote markers from multi-line fragments", () => {
    const text = "> Quoted\n> \\[\n> a^2+b^2\n> \\]";
    expect(findMathFragments(text)[0].tex).toBe("\na^2+b^2\n");
  });

  test("display math may span blank lines only when it stands on its own lines", () => {
    expect(findMathFragments("Equation:\n\\[\nx^2\n\n+ y^2\n\\]\nAfter.")[0]?.tex).toBe("\nx^2\n\n+ y^2\n");
    expect(findMathFragments("echo $$ is a pid.\n\nLater $$ again.")).toEqual([]);
  });

  test("stays linear on pathological unclosed delimiters", () => {
    const text = "\\(".repeat(50_000) + "$".repeat(50_000) + "\\[".repeat(50_000);
    const started = performance.now();
    expect(findMathFragments(text)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  test("moves display fragments onto their own placeholder lines", () => {
    const extracted = extractDisplayMath("Therefore \\[ b = 8.4 \\] so.\n\nThe answer is $$x=1$$.");
    expect(extracted?.text.replace(/\uE0F0(\d+)\uE0F1/g, "<$1>")).toBe("Therefore\n<0>\nso.\n\nThe answer is\n<1>");
    expect(extracted?.blocks.map(block => [block.source, block.trailing])).toEqual([
      [String.raw`\[ b = 8.4 \]`, ""],
      ["$$x=1$$", "."],
    ]);
  });
});

describe("inline math in prose", () => {
  test("renders slash and dollar delimiters and unescapes \\$", () => {
    expect(renderInlineMath(String.raw`Use \(P\land Q\), then $x^2 + y_1$; fee \$5.`))
      .toBe("Use P ∧ Q, then x² + y₁; fee $5.");
  });

  test("leaves currency, code spans and unclosed delimiters alone", () => {
    for (const input of [
      "It costs $5 and at most $10 today.",
      "Fall tuition is $33,055 and Winter is $33,055.",
      "**$100k** and **$60k**.",
      "*$5*–*$10*",
      "Prices: $5-$10, $20/$30.",
      "**$50k accounting profit − $62k implicit costs = −$12k economic profit.**",
      "Code `\\(x^2\\)` and ``$y_1$``.",
      "Unclosed \\(x^2",
    ]) {
      expect(renderInlineMath(input)).toBe(input);
    }
  });

  test("joins a fragment that spans a hard newline and keeps code spans across lines", () => {
    const chunks = (lines: string[]) => renderInlineMathChunks(lines).map(line => line.replace(/\u00A0/g, " "));
    expect(chunks(["Sum \\(a +", "b\\) done", "next"])).toEqual(["Sum a + b done", "next"]);
    expect(chunks(["Before `literal \\(x^2\\)", "still literal` and \\(y^2\\)"]))
      .toEqual(["Before `literal \\(x^2\\)", "still literal` and y²"]);
    expect(chunks(["Do not join $x", "and y$ across lines."]))
      .toEqual(["Do not join $x", "and y$ across lines."]);
  });

  test("only wraps inline math after relations and operators", () => {
    const rows = plainRows(String.raw`Since \(a,b\in A\) and \(x\le a\) we are done with this proof here.`, 30);
    for (const row of rows) expect(row).not.toMatch(/(?:^|\s)(?:b ∈|∈ A|, b)$/);
    expect(rows.join(" ")).toContain("a, b ∈ A");
  });
});

describe("display math blocks in Markdown", () => {
  test("renders the owner's screenshot answer as indented blocks", () => {
    const markdown = MATH_CASES[0].markdown;
    expect(plainRows(markdown, 72)).toEqual([
      "Not quite, the new supply is P=Q+10.",
      "",
      "Substitute into demand:",
      "                            229         259",
      "  Q = 249 − 2(Q + 10) ⇒ Q = ───,    P = ───.",
      "                             3           3",
      "",
      "Producer surplus is the triangle above the new supply curve:",
      "                     ⎛ 229 ⎞²   ┌─────────┐",
      "  PS = ½Q(P − 10) = ½⎜ ─── ⎟  ≈ │ 2913.39 │.",
      "                     ⎝  3  ⎠    └─────────┘",
    ]);
  });

  test("never splits a display number across rows at narrow widths", () => {
    const rows = plainRows(String.raw`\[PS=\frac12 Q(P-10)=\frac12(229/3)^2=\boxed{2913.39}.\]`, 30);
    expect(rows.some(row => row.includes("2913.39"))).toBe(true);
    expect(rows.every(row => termWidth(row) <= 30)).toBe(true);
  });

  test("yanks of display and inline math copy the original TeX", () => {
    const markdown = [
      "Since \\(x^2\\ge0\\) we get **this**:",
      "\\[",
      "\\frac{a}{b} \\le 1",
      "\\]",
    ].join("\n");
    const rendered = markdownWordWrap(markdown, 60, "\x1b[0m");
    const wholeCopy = joinLogicalLines(rendered.lines, rendered.cont, 0, rendered.lines.length - 1, rendered.join, rendered.copy);
    expect(wholeCopy).toBe("Since \\(x^2\\ge0\\) we get this:\n\\[\n\\frac{a}{b} \\le 1\n\\]");
    // A line yank from the middle row of the stacked fraction copies the block.
    const middle = rendered.lines.findIndex(line => stripAnsi(line).includes("─"));
    let first = middle;
    while (first > 0 && rendered.cont[first]) first--;
    let last = middle;
    while (last + 1 < rendered.lines.length && rendered.cont[last + 1]) last++;
    expect(joinLogicalLines(rendered.lines, rendered.cont, first, last, rendered.join, rendered.copy))
      .toBe("\\[\n\\frac{a}{b} \\le 1\n\\]");
    // Character-wise selections still see the rendered text.
    expect(rendered.copy?.[middle]?.text).toContain("─");
  });

  test("standalone display block reader is unchanged", () => {
    expect(takeDisplayMathBlock([String.raw`\[x^2 + y^2=z^2\]`], 0)).toEqual({ source: "x^2 + y^2=z^2", nextLine: 1 });
    expect(takeDisplayMathBlock([String.raw`\[`, "unclosed"], 0)).toBeNull();
  });
});

describe("real conversation corpus and targeted cases", () => {
  const items = [
    ...MATH_CASES.map(item => ({ name: item.name, markdown: item.markdown })),
    ...(corpus as Array<{ id: string; model: string; text: string }>).map(item => ({ name: `${item.id} (${item.model})`, markdown: item.text })),
  ];

  test("no fragment renders raw TeX commands or private-use placeholders", () => {
    for (const item of items) {
      for (const fragment of findMathFragments(item.markdown)) {
        const rendered = convertLatexMath(fragment.tex, fragment.display);
        expect({ source: fragment.tex, rendered }).not.toMatchObject({ rendered: expect.stringMatching(/\\[A-Za-z]/) });
        expect(rendered).not.toMatch(/[\uE000-\uF8FF]/);
      }
    }
  });

  for (const width of [72, 44]) {
    test(`renders every message within ${width} columns`, () => {
      const snapshot: string[] = [];
      for (const item of items) {
        const rendered = markdownWordWrap(item.markdown, width, "\x1b[0m");
        const rows = rendered.lines.map(line => stripAnsi(line).replace(/\u00A0/g, " "));
        for (const row of rows) expect(termWidth(row)).toBeLessThanOrEqual(width);
        snapshot.push(`=== ${item.name}`, ...rows.map((row, index) => `${rendered.cont[index] ? "+" : "|"}${row}`));
      }
      expect(snapshot.join("\n")).toMatchSnapshot();
    });
  }
});
