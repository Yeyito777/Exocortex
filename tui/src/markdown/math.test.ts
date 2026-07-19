import { describe, expect, test } from "bun:test";
import {
  convertLatexMath,
  renderDisplayMath,
  renderInlineMath,
  renderInlineMathChunks,
  takeDisplayMathBlock,
} from "./math";

describe("terminal LaTeX conversion", () => {
  test("renders the logic notation used in the reference conversation", () => {
    expect(convertLatexMath(String.raw`\neg(P\land Q)\iff(\neg P\lor\neg Q)`))
      .toBe("¬(P ∧ Q) ⇔ (¬ P ∨ ¬ Q)");

    expect(convertLatexMath(
      String.raw`\forall x\big((0<x)\Rightarrow \exists y((0<y)\land(y<x))\big)`,
    )).toBe("∀ x((0<x) ⇒ ∃ y((0<y) ∧ (y<x)))");
  });

  test("renders fractions, roots, scripts, Greek, and common structural wrappers", () => {
    expect(convertLatexMath(String.raw`\frac{8\pi G}{c^{4}}`)).toBe("(8π G)/(c⁴)");
    expect(convertLatexMath(String.raw`\sqrt{x_1} + \sqrt[3]{y}`)).toBe("√(x₁) + root(3, y)");
    expect(convertLatexMath(String.raw`\mathbb{R},\ \binom{n}{k},\ \vec{x}`))
      .toBe("ℝ, C(n, k), x⃗");
  });

  test("renders matrices compactly inline and structurally in display mode", () => {
    const source = String.raw`\begin{pmatrix}a&b\\c&d\end{pmatrix}`;
    expect(convertLatexMath(source)).toBe("(a b; c d)");
    expect(convertLatexMath(source, true)).toBe("⎛ a b ⎞\n⎝ c d ⎠");
  });

  test("collapses pretty-printed display source while preserving structural environment rows", () => {
    const ordinary = String.raw`\forall x\exists y\Big(
      (y\times y\times y=x)
      \land
      \forall z\big(
        (z\times z\times z=x)\Rightarrow(z=y)
      \big)
    \Big).`;
    expect(convertLatexMath(ordinary, true)).toBe(
      "∀ x∃ y((y × y × y=x) ∧ ∀ z((z × z × z=x) ⇒ (z=y))).",
    );

    const aligned = String.raw`\begin{aligned}
      x &= 1 \\
      y &= 2
    \end{aligned}`;
    expect(convertLatexMath(aligned, true)).toBe("x = 1\ny = 2");
  });

  test("preserves unknown commands and survives malformed input", () => {
    expect(convertLatexMath(String.raw`x + \unknown{y}`)).toContain("\\unknown");
    expect(() => convertLatexMath(String.raw`\frac{{{{`)).not.toThrow();
  });
});

describe("inline math delimiters", () => {
  test("renders slash and dollar delimiters", () => {
    expect(renderInlineMath(String.raw`Use \(P\land Q\), then $x^2 + y_1$.`))
      .toBe("Use P ∧ Q, then x² + y₁.");
  });

  test("does not mistake currency for a math span", () => {
    expect(renderInlineMath("It costs $5 and at most $10 today.")).toBe("It costs $5 and at most $10 today.");
    expect(renderInlineMath("Fall tuition is $33,055 and Winter is $33,055.")).toBe(
      "Fall tuition is $33,055 and Winter is $33,055.",
    );
  });

  test("protects Markdown code spans from math rendering", () => {
    const input = "Math \\(x^2\\); code `\\(x^2\\)`; more ``$y_1$``.";
    expect(renderInlineMath(input)).toBe("Math x²; code `\\(x^2\\)`; more ``$y_1$``.");
  });

  test("protects code spans that cross a hard newline", () => {
    expect(renderInlineMathChunks([
      "Before `literal \\(x^2\\)",
      "still literal` and \\(y^2\\)",
    ])).toEqual([
      "Before `literal \\(x^2\\)",
      "still literal` and y²",
    ]);
  });

  test("leaves escaped, unclosed, and ordinary delimiters untouched", () => {
    expect(renderInlineMath(String.raw`Price \$5; unclosed \(x^2`)).toBe(String.raw`Price \$5; unclosed \(x^2`);
  });
});

describe("display math blocks", () => {
  test("reads single-line and multiline display delimiters", () => {
    expect(takeDisplayMathBlock([String.raw`\[x^2 + y^2=z^2\]`], 0)).toEqual({
      source: "x^2 + y^2=z^2",
      nextLine: 1,
    });
    expect(takeDisplayMathBlock([String.raw`\[`, String.raw`P\land Q`, String.raw`\]`, "after"], 0)).toEqual({
      source: "\nP\\land Q\n",
      nextLine: 3,
    });
    expect(takeDisplayMathBlock([String.raw`\[`, "unclosed"], 0)).toBeNull();
  });

  test("keeps rendered display rows plain and left aligned while exposing copy text", () => {
    const rendered = renderDisplayMath(String.raw`P\land Q`, 20);
    expect(rendered.lines[0]).toBe("P ∧ Q");
    expect(rendered.copy[0]?.text).toBe("P ∧ Q");
    expect(rendered.copy[0]?.displayStart).toBe(0);
    expect(rendered.cont).toEqual([false]);
  });
});
