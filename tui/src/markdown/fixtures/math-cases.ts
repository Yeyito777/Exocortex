/**
 * Targeted Markdown + TeX cases for the terminal math renderer. Each case is
 * a whole assistant message, rendered through markdownWordWrap in the tests
 * and snapshotted alongside the real-conversation corpus (math-corpus.json).
 */
export interface MathCase {
  name: string;
  markdown: string;
}

export const MATH_CASES: MathCase[] = [
  {
    name: "owner example: display math with brace-less fractions and boxed answer",
    markdown: String.raw`Not quite, the new supply is **P=Q+10**.

Substitute into demand:
\[
Q=249-2(Q+10)\Rightarrow Q=\frac{229}{3},\qquad P=\frac{259}{3}.
\]

Producer surplus is the triangle above the **new** supply curve:
\[
PS=\frac12 Q(P-10)=\frac12\left(\frac{229}{3}\right)^2\approx \boxed{2913.39}.
\]`,
  },
  {
    name: "owner example: inline variant",
    markdown: String.raw`Producer surplus: \(PS=\frac12 Q(P-10)=\frac12(229/3)^2\) \(\approx 2913.39\).`,
  },
  {
    name: "all delimiters",
    markdown: String.raw`Dollar $x^2+y^2=z^2$, slash \(a_n\to 0\), and display:

$$\sum_{i=1}^{n} i = \frac{n(n+1)}{2}$$

\[
\int_0^1 x^2\,dx = \frac13
\]

\begin{equation}
E = mc^2
\end{equation}

\begin{align}
f(x) &= x^2 + 2x + 1 \\
     &= (x+1)^2
\end{align}`,
  },
  {
    name: "display math mid-line and trailing punctuation",
    markdown: String.raw`Therefore \[ b + 2b + (2b - 3) = 39 \Rightarrow b = 8.4 \] so the data are inconsistent.

The answer is $$x = \frac{-b \pm \sqrt{b^2-4ac}}{2a}$$.`,
  },
  {
    name: "environments",
    markdown: String.raw`$$
f(x)=\begin{cases}
x^2, & x \ge 0,\\
-x, & x < 0.
\end{cases}
$$

$$
A=\begin{pmatrix}1 & 2\\ 3 & 4\end{pmatrix},\quad
B=\begin{bmatrix}a & b & c\\ d & e & f\end{bmatrix}
$$

$$
\begin{aligned}
\nabla \cdot \mathbf{E} &= \frac{\rho}{\varepsilon_0} \\
\nabla \times \mathbf{B} &= \mu_0 \mathbf{J} + \mu_0\varepsilon_0 \frac{\partial \mathbf{E}}{\partial t}
\end{aligned}
$$

Inline matrix \(\begin{pmatrix}a&b\\c&d\end{pmatrix}\) and cases \(|x|=\begin{cases}x,&x\ge0\\-x,&x<0\end{cases}\).`,
  },
  {
    name: "brace-less arguments",
    markdown: String.raw`Forms: \(\frac12\), \(\frac{1}2\), \(\frac1{2}\), \(\frac ab\), \(\frac\pi2\), \(\sqrt2\), \(\sqrt x\), \(x^2\), \(x^23\), \(x_ij\), \(x_{ij}\), \(e^{i\pi}+1=0\), \(\tfrac34\), \(\dfrac{a+b}{c}\).`,
  },
  {
    name: "fractions need parentheses",
    markdown: String.raw`\(\frac{a+b}{c}\), \(\frac{1}{2\pi}\), \(C\frac{A}{T}\), \(\frac{v-s}{v}\), \(\left(\frac{v-s}{v}\right)^2\), \(\frac{x}{y}^2\), \(\frac{\max(1,L)}{q}\), \(\frac{q}{\max(1,L)}\), \(\frac{7}{12}\), \(2\frac{1}{3}\).`,
  },
  {
    name: "operators, relations and spacing",
    markdown: String.raw`\(a\cdot b\times c\), \(x\approx y\), \(a\le b\ge c\neq d\), \(\pm 1\), \(\infty\), \(f\colon A\to B\), \(P\Rightarrow Q\iff R\), \(1,\!000\), \(a\,b\;c\quad d\qquad e\), \(1,2,\dots,n\), \(x_1+\cdots+x_n\), \(-x\), \(a-b\), \(n!\), \(f'(x)\), \(f''(x)\), \(90^\circ\), \(\neg(P\land Q)\iff(\neg P\lor\neg Q)\), \(x\not\in A\), \(a \bmod n\), \(a\equiv b\pmod n\).`,
  },
  {
    name: "big operators with limits",
    markdown: String.raw`Inline \(\sum_{i=1}^n x_i\), \(\prod_{k=1}^{N} k\), \(\int_0^\infty e^{-x}\,dx\), \(\lim_{x\to 0}\frac{\sin x}{x}=1\), \(\max_{i} a_i\).

$$\sum_{i=1}^{n} x_i^2 \le \left(\sum_{i=1}^{n} |x_i|\right)^2$$

$$\lim_{n\to\infty}\left(1+\frac{1}{n}\right)^n = e$$

$$\int_{-\infty}^{\infty} e^{-x^2}\,dx = \sqrt{\pi}$$`,
  },
  {
    name: "text and font commands",
    markdown: String.raw`\(\text{if } x>0\), \(\mathrm{d}x\), \(\operatorname{rank}(A)\), \(\operatorname{clamp}_{[0,1]}(x)\), \(\mathbb{R}^n\), \(\mathbb{N}\), \(\mathbb{E}[X]\), \(\boldsymbol{\beta}\), \(\mathbf{v}\), \(\mathcal{L}\), \(\lambda_{\text{extra}}\), \(E_{\mathrm{net},30}\), \(\hat\theta\), \(\bar{x}\), \(\vec{v}\), \(\overline{AB}\), \(\tilde{x}\).`,
  },
  {
    name: "scripts without Unicode forms",
    markdown: String.raw`\(u^{0.2547}\), \(e^{1.691x(t)}\), \(W_i^Q\), \(K^\top\), \(x^{n+1}\), \(a_{n-1}\), \(2^{-k}\), \(x^{y_1+\alpha}\), \(\sigma^2_{\text{post}}\), \(x^*\), \(A^{-1}\), \(f^{(n)}(x)\).`,
  },
  {
    name: "unknown commands and malformed input",
    markdown: String.raw`Unknown \(x+\unknown{y}\), \(\foo\), \(\frac{1}{\), \(x^{\), \(\sqrt[3]{x}\), \(\sqrt[n]{x}\), \(\left(\frac12\right.\), \(\color{red}{x}+\textcolor{blue}{y}\), \(\label{eq:1}x=1\tag{3}\).`,
  },
  {
    name: "prices are not math",
    markdown: String.raw`It costs $5 and at most $10 today. Fall tuition is $33,055 and Winter is $33,055.
Pay **$100k** and **$60k**; Prices: $5-$10, $20/$30. The fee is \$5 and the rebate is \$2.
Shell: run ${"`"}echo $$${"`"} or ${"`"}kill -TERM $$${"`"}, and use $x^2$ for squares.`,
  },
  {
    name: "code spans and blocks are not math",
    markdown: [
      String.raw`Literal ${"`"}\(x^2\)${"`"} and ${"``"}$y_1$${"``"} stay; math \(x^2\) renders.`,
      "",
      "```tex",
      String.raw`\[`,
      "x^2",
      String.raw`\]`,
      "$a$ and $$b$$",
      "```",
      "",
      "```bash",
      "PID=$$",
      'echo "$HOME" "$PATH"',
      "```",
      "",
      String.raw`After the block \(y^2\).`,
    ].join("\n"),
  },
  {
    name: "math across wrapped lines, lists, tables and blockquotes",
    markdown: String.raw`A long sentence whose inline math \(\sum_{k=1}^{n} \frac{1}{k^2} < \frac{\pi^2}{6}\) has to wrap somewhere in the middle of the paragraph at narrow widths.

Inline math across a hard newline \(a +
b = c\) still renders.

- Item with \(x\in\mathbb{R}\):
  \[
  x^2 \ge 0
  \]
- Item two \(y=\frac{1}{2}\)

| Quantity | Formula |
|---|---|
| Area | \(\pi r^2\) |
| Mean | $\bar x = \frac1n\sum x_i$ |

> Quoted \(E=mc^2\) and
> \[
> a^2+b^2=c^2
> \]`,
  },
  {
    name: "real-world display formulas",
    markdown: String.raw`\[
\text{Attention}(Q,K,V)=\text{softmax}\left(\frac{QK^\top}{\sqrt{d_k}}\right)V
\]

\[
u=\frac{q}{\max(1,L)},\qquad
P(\text{maker response})=
\frac{u^{0.25}}{u^{0.25}+0.42\max(1,a)^{0.30}}
\]

\[
3.4\text{ GFLOPs} \times 4 \times 3 \approx 41\text{ GFLOPs/sample}
\]

\[
C=S\,[b+(1-a)]=S\,(1-\text{book spread})
\]

\[
O(P + K + R) = O(H)
\]`,
  },
];
