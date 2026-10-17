/**
 * Symbol tables for terminal math rendering (see math.ts).
 *
 * Every TeX command maps to a glyph and a TeX atom class. The class drives
 * spacing: binary operators and relations get a space on each side, as in
 * typeset TeX, while ordinary symbols sit next to each other.
 */

export type AtomClass = "ord" | "op" | "bin" | "rel" | "open" | "close" | "punct";

export interface SymbolInfo {
  text: string;
  cls: AtomClass;
}

const sym = (text: string, cls: AtomClass = "ord"): SymbolInfo => ({ text, cls });

function table(cls: AtomClass, entries: Record<string, string>): Record<string, SymbolInfo> {
  const out: Record<string, SymbolInfo> = {};
  for (const [name, text] of Object.entries(entries)) out[name] = sym(text, cls);
  return out;
}

const GREEK = table("ord", {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ϵ", varepsilon: "ε", zeta: "ζ", eta: "η",
  theta: "θ", vartheta: "ϑ", iota: "ι", kappa: "κ", varkappa: "ϰ", lambda: "λ", mu: "μ", nu: "ν", xi: "ξ",
  omicron: "ο", pi: "π", varpi: "ϖ", rho: "ρ", varrho: "ϱ", sigma: "σ", varsigma: "ς", tau: "τ",
  upsilon: "υ", phi: "ϕ", varphi: "φ", chi: "χ", psi: "ψ", omega: "ω",
  Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π", Sigma: "Σ", Upsilon: "Υ",
  Phi: "Φ", Psi: "Ψ", Omega: "Ω", varGamma: "Γ", varDelta: "Δ", varTheta: "Θ", varLambda: "Λ",
  varXi: "Ξ", varPi: "Π", varSigma: "Σ", varUpsilon: "Υ", varPhi: "Φ", varPsi: "Ψ", varOmega: "Ω",
  digamma: "ϝ",
});

const ORDINARY = table("ord", {
  infty: "∞", partial: "∂", nabla: "∇", emptyset: "∅", varnothing: "∅", forall: "∀", exists: "∃",
  nexists: "∄", ell: "ℓ", hbar: "ℏ", hslash: "ℏ", Re: "ℜ", Im: "ℑ", aleph: "ℵ", beth: "ℶ", wp: "℘",
  angle: "∠", measuredangle: "∡", triangle: "△", degree: "°", prime: "′", top: "⊤", bot: "⊥",
  dagger: "†", ddagger: "‡", therefore: "∴", because: "∵", checkmark: "✓", square: "□", Box: "□",
  blacksquare: "■", qed: "∎", S: "§", P: "¶", dots: "…", ldots: "…", cdots: "⋯", vdots: "⋮",
  ddots: "⋱", dotsc: "…", dotsb: "⋯", dotsm: "⋯", dotsi: "⋯", dotso: "…", imath: "ı", jmath: "ȷ",
  neg: "¬", lnot: "¬", flat: "♭", natural: "♮", sharp: "♯", clubsuit: "♣", diamondsuit: "♢",
  heartsuit: "♡", spadesuit: "♠", infin: "∞", backslash: "\\", surd: "√", complement: "∁",
  diagup: "╱", diagdown: "╲", lozenge: "◊", star: "⋆", bigstar: "★", copyright: "©",
  pounds: "£", euro: "€", yen: "¥", textdollar: "$", dollar: "$",
  "{": "{", "}": "}", "$": "$", "%": "%", "#": "#", "&": "&", "_": "_",
});

const BINARY = table("bin", {
  pm: "±", mp: "∓", times: "×", div: "÷", cdot: "·", ast: "∗", circ: "∘", bullet: "•", oplus: "⊕",
  ominus: "⊖", otimes: "⊗", oslash: "⊘", odot: "⊙", cup: "∪", cap: "∩", sqcup: "⊔", sqcap: "⊓",
  uplus: "⊎", setminus: "∖", smallsetminus: "∖", land: "∧", lor: "∨", wedge: "∧", vee: "∨",
  diamond: "⋄", bigtriangleup: "△", bigtriangledown: "▽", triangleleft: "◁", triangleright: "▷",
  wr: "≀", amalg: "⨿", dotplus: "∔", ltimes: "⋉", rtimes: "⋊", centerdot: "·", divideontimes: "⋇",
  boxplus: "⊞", boxtimes: "⊠", intercal: "⊺", bmod: "mod",
});

const RELATIONS = table("rel", {
  le: "≤", leq: "≤", leqslant: "≤", ge: "≥", geq: "≥", geqslant: "≥", ne: "≠", neq: "≠", lt: "<", gt: ">",
  approx: "≈", approxeq: "≊", equiv: "≡", sim: "∼", simeq: "≃", cong: "≅", propto: "∝", varpropto: "∝",
  subset: "⊂", subseteq: "⊆", subsetneq: "⊊", supset: "⊃", supseteq: "⊇", supsetneq: "⊋",
  in: "∈", notin: "∉", ni: "∋", owns: "∋", ll: "≪", gg: "≫", lll: "⋘", ggg: "⋙",
  lesssim: "≲", gtrsim: "≳", lessapprox: "⪅", gtrapprox: "⪆", prec: "≺", succ: "≻", preceq: "⪯",
  succeq: "⪰", nless: "≮", ngtr: "≯", nleq: "≰", ngeq: "≱", nsubseteq: "⊈", nsupseteq: "⊉",
  parallel: "∥", nparallel: "∦", perp: "⟂", mid: "∣", nmid: "∤", vdash: "⊢", dashv: "⊣", models: "⊨",
  vDash: "⊨", asymp: "≍", doteq: "≐", triangleq: "≜", coloneqq: "≔", eqqcolon: "≕", coloneq: "≔",
  approxident: "≋", bowtie: "⋈", smile: "⌣", frown: "⌢", sqsubset: "⊏", sqsupset: "⊐",
  sqsubseteq: "⊑", sqsupseteq: "⊒", lhd: "⊲", rhd: "⊳", unlhd: "⊴", unrhd: "⊵",
  to: "→", gets: "←", rightarrow: "→", leftarrow: "←", leftrightarrow: "↔", Rightarrow: "⇒",
  Leftarrow: "⇐", Leftrightarrow: "⇔", longrightarrow: "→", longleftarrow: "←",
  longleftrightarrow: "↔", Longrightarrow: "⇒", Longleftarrow: "⇐", Longleftrightarrow: "⇔",
  implies: "⇒", impliedby: "⇐", iff: "⇔", mapsto: "↦", longmapsto: "↦", uparrow: "↑",
  downarrow: "↓", updownarrow: "↕", Uparrow: "⇑", Downarrow: "⇓", Updownarrow: "⇕",
  nearrow: "↗", searrow: "↘", swarrow: "↙", nwarrow: "↖", hookrightarrow: "↪", hookleftarrow: "↩",
  rightharpoonup: "⇀", rightharpoondown: "⇁", leftharpoonup: "↼", leftharpoondown: "↽",
  rightleftharpoons: "⇌", leftrightharpoons: "⇋", leadsto: "⇝", rightsquigarrow: "⇝",
  twoheadrightarrow: "↠", rightrightarrows: "⇉", leftleftarrows: "⇇", xrightarrow: "→",
  xleftarrow: "←", nrightarrow: "↛", nleftarrow: "↚", nRightarrow: "⇏", nLeftarrow: "⇍",
  nLeftrightarrow: "⇎", nleftrightarrow: "↮", circlearrowleft: "↺", circlearrowright: "↻",
  curvearrowleft: "↶", curvearrowright: "↷", nsim: "≁", ncong: "≇", nequiv: "≢", napprox: "≉",
  vartriangleleft: "⊲", vartriangleright: "⊳", between: "≬", pitchfork: "⋔",
});

const DELIMITERS: Record<string, SymbolInfo> = {
  langle: sym("⟨", "open"), rangle: sym("⟩", "close"), lceil: sym("⌈", "open"), rceil: sym("⌉", "close"),
  lfloor: sym("⌊", "open"), rfloor: sym("⌋", "close"), lvert: sym("|", "open"), rvert: sym("|", "close"),
  lVert: sym("‖", "open"), rVert: sym("‖", "close"), vert: sym("|"), Vert: sym("‖"), "|": sym("‖"),
  lbrace: sym("{", "open"), rbrace: sym("}", "close"), lbrack: sym("[", "open"), rbrack: sym("]", "close"),
  lparen: sym("(", "open"), rparen: sym(")", "close"), ulcorner: sym("⌜", "open"), urcorner: sym("⌝", "close"),
  llcorner: sym("⌞", "open"), lrcorner: sym("⌟", "close"), lgroup: sym("(", "open"), rgroup: sym(")", "close"),
};

const PUNCTUATION: Record<string, SymbolInfo> = {
  colon: sym(":", "punct"), ldotp: sym(".", "punct"), cdotp: sym("·", "punct"),
};

/** Upright operator names (`\sin x`). */
export const FUNCTION_NAMES = new Set([
  "sin", "cos", "tan", "cot", "sec", "csc", "arcsin", "arccos", "arctan", "arccot", "sinh", "cosh",
  "tanh", "coth", "sech", "csch", "log", "ln", "lg", "exp", "det", "dim", "deg", "gcd", "lcm", "hom",
  "ker", "arg", "Pr", "tr", "Tr", "rank", "sgn", "sign", "diag", "Var", "Cov", "erf", "mod",
  "lim", "limsup", "liminf", "max", "min", "sup", "inf", "argmax", "argmin", "injlim", "projlim",
]);

/** Operator names that take limits above/below in display style. */
export const LIMIT_OPERATORS = new Set([
  "lim", "limsup", "liminf", "max", "min", "sup", "inf", "argmax", "argmin", "det", "gcd", "Pr",
  "injlim", "projlim",
]);

export const OPERATOR_DISPLAY_NAMES: Record<string, string> = {
  limsup: "lim sup", liminf: "lim inf", argmax: "arg max", argmin: "arg min", injlim: "inj lim",
  projlim: "proj lim",
};

/** Large operators: [glyph, takes limits in display style]. */
export const LARGE_OPERATORS: Record<string, [string, boolean]> = {
  sum: ["∑", true], prod: ["∏", true], coprod: ["∐", true], bigcup: ["⋃", true], bigcap: ["⋂", true],
  bigvee: ["⋁", true], bigwedge: ["⋀", true], bigoplus: ["⨁", true], bigotimes: ["⨂", true],
  bigodot: ["⨀", true], biguplus: ["⨄", true], bigsqcup: ["⨆", true],
  int: ["∫", false], iint: ["∬", false], iiint: ["∭", false], oint: ["∮", false], intop: ["∫", true],
  smallint: ["∫", false], oiint: ["∯", false],
};

export const SYMBOLS: Record<string, SymbolInfo> = {
  ...GREEK, ...ORDINARY, ...BINARY, ...RELATIONS, ...DELIMITERS, ...PUNCTUATION,
};

/** Single characters inside math mode. */
export function charClass(char: string): AtomClass {
  if ("+-*±∓×÷·∗∘⊕⊗∪∩∧∨∖".includes(char)) return "bin";
  if ("=<>:≤≥≠≈≡∼≃≅∝⊂⊆⊃⊇∈∉∋→←↔⇒⇐⇔↦≪≫≲≳∣∥⟂⊢⊨≔".includes(char)) return "rel";
  if ("([⟨⌈⌊".includes(char)) return "open";
  if (")]⟩⌉⌋".includes(char)) return "close";
  if (",;".includes(char)) return "punct";
  return "ord";
}

/** `\not` applied to a relation. */
export const NEGATED: Record<string, string> = {
  "=": "≠", "<": "≮", ">": "≯", "≤": "≰", "≥": "≱", "∈": "∉", "∋": "∌", "⊂": "⊄", "⊃": "⊅",
  "⊆": "⊈", "⊇": "⊉", "≡": "≢", "∼": "≁", "≈": "≉", "≅": "≇", "∣": "∤", "∥": "∦", "→": "↛",
  "←": "↚", "↔": "↮", "⇒": "⇏", "⇐": "⇍", "⇔": "⇎", "≃": "≄", "⊢": "⊬", "⊨": "⊭", "∃": "∄",
};

const SUPERSCRIPTS: Record<string, string> = {
  "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
  "+": "⁺", "−": "⁻", "-": "⁻", "=": "⁼", "(": "⁽", ")": "⁾",
  a: "ᵃ", b: "ᵇ", c: "ᶜ", d: "ᵈ", e: "ᵉ", f: "ᶠ", g: "ᵍ", h: "ʰ", i: "ⁱ", j: "ʲ", k: "ᵏ", l: "ˡ", m: "ᵐ",
  n: "ⁿ", o: "ᵒ", p: "ᵖ", r: "ʳ", s: "ˢ", t: "ᵗ", u: "ᵘ", v: "ᵛ", w: "ʷ", x: "ˣ", y: "ʸ", z: "ᶻ",
  A: "ᴬ", B: "ᴮ", D: "ᴰ", E: "ᴱ", G: "ᴳ", H: "ᴴ", I: "ᴵ", J: "ᴶ", K: "ᴷ", L: "ᴸ", M: "ᴹ", N: "ᴺ",
  O: "ᴼ", P: "ᴾ", R: "ᴿ", T: "ᵀ", U: "ᵁ", V: "ⱽ", W: "ᵂ",
  "α": "ᵅ", "β": "ᵝ", "γ": "ᵞ", "δ": "ᵟ", "ε": "ᵋ", "ϵ": "ᵋ", "θ": "ᶿ", "ι": "ᶥ", "ϕ": "ᵠ", "φ": "ᵠ",
  "χ": "ᵡ", "⊤": "ᵀ", "′": "′", "″": "″", "‴": "‴", "∘": "°", "°": "°", "∗": "∗", "†": "†", "‡": "‡",
  "⊥": "⊥",
};

const SUBSCRIPTS: Record<string, string> = {
  "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉",
  "+": "₊", "−": "₋", "-": "₋", "=": "₌", "(": "₍", ")": "₎",
  a: "ₐ", e: "ₑ", h: "ₕ", i: "ᵢ", j: "ⱼ", k: "ₖ", l: "ₗ", m: "ₘ", n: "ₙ", o: "ₒ", p: "ₚ", r: "ᵣ",
  s: "ₛ", t: "ₜ", u: "ᵤ", v: "ᵥ", x: "ₓ",
  "β": "ᵦ", "γ": "ᵧ", "ρ": "ᵨ", "ϕ": "ᵩ", "φ": "ᵩ", "χ": "ᵪ",
};

function mapAll(text: string, map: Record<string, string>): string | null {
  let out = "";
  for (const char of text) {
    const mapped = map[char];
    if (mapped === undefined) return null;
    out += mapped;
  }
  return out;
}

/** Unicode superscript for the whole text, or null when any character lacks one. */
export function toSuperscript(text: string): string | null {
  return text ? mapAll(text, SUPERSCRIPTS) : null;
}

/** Unicode subscript for the whole text, or null when any character lacks one. */
export function toSubscript(text: string): string | null {
  return text ? mapAll(text, SUBSCRIPTS) : null;
}

/** Simple digit fractions with a single-glyph Unicode form. */
export const VULGAR_FRACTIONS: Record<string, string> = {
  "1/2": "½", "1/3": "⅓", "2/3": "⅔", "1/4": "¼", "3/4": "¾", "1/5": "⅕", "2/5": "⅖", "3/5": "⅗",
  "4/5": "⅘", "1/6": "⅙", "5/6": "⅚", "1/7": "⅐", "1/8": "⅛", "3/8": "⅜", "5/8": "⅝", "7/8": "⅞",
  "1/9": "⅑", "1/10": "⅒",
};

// Letterlike forms are in the Basic Multilingual Plane and present in common
// terminal fonts; other mathematical alphanumerics fall back to plain letters.
const DOUBLE_STRUCK: Record<string, string> = {
  C: "ℂ", H: "ℍ", N: "ℕ", P: "ℙ", Q: "ℚ", R: "ℝ", Z: "ℤ", "1": "𝟙", k: "𝕜",
};
const CALLIGRAPHIC: Record<string, string> = {
  B: "ℬ", E: "ℰ", F: "ℱ", H: "ℋ", I: "ℐ", L: "ℒ", M: "ℳ", R: "ℛ", e: "ℯ", g: "ℊ", o: "ℴ",
};
const FRAKTUR: Record<string, string> = { C: "ℭ", H: "ℌ", I: "ℑ", R: "ℜ", Z: "ℨ" };

export type FontStyle = "plain" | "double" | "script" | "fraktur";

export function applyFont(text: string, font: FontStyle): string {
  const map = font === "double" ? DOUBLE_STRUCK : font === "script" ? CALLIGRAPHIC : font === "fraktur" ? FRAKTUR : null;
  if (!map) return text;
  return Array.from(text, char => map[char] ?? char).join("");
}

export const FONT_COMMANDS: Record<string, FontStyle> = {
  mathbb: "double", Bbb: "double", mathbbm: "double", varmathbb: "double",
  mathcal: "script", mathscr: "script",
  mathfrak: "fraktur",
  mathrm: "plain", mathit: "plain", mathbf: "plain", mathsf: "plain", mathtt: "plain",
  mathnormal: "plain", boldsymbol: "plain", bm: "plain", pmb: "plain", mathbfit: "plain",
  mathup: "plain", symbf: "plain", symrm: "plain", mathring: "plain",
};

export const TEXT_COMMANDS = new Set([
  "text", "textrm", "textit", "textbf", "texttt", "textsf", "textup", "textnormal", "textmd",
  "mbox", "hbox", "emph", "textsl", "textsc",
]);

/** Combining marks for accents. */
export const ACCENTS: Record<string, string> = {
  hat: "̂", widehat: "̂", check: "̌", widecheck: "̌", tilde: "̃",
  widetilde: "̃", acute: "́", grave: "̀", dot: "̇", ddot: "̈",
  dddot: "⃛", breve: "̆", bar: "̄", vec: "⃗", overrightarrow: "⃗",
  overleftarrow: "⃖", overleftrightarrow: "⃡", overline: "̅", underline: "̲",
  mathring: "̊", utilde: "̰", underbar: "̲",
};

/** Names for accents written out where a terminal cannot draw combining marks. */
export const ACCENT_NAMES: Record<string, string> = {
  "\u0302": "hat", "\u030C": "check", "\u0303": "tilde", "\u0301": "acute", "\u0300": "grave",
  "\u0307": "dot", "\u0308": "ddot", "\u20DB": "dddot", "\u0306": "breve", "\u0304": "bar",
  "\u20D7": "vec", "\u20D6": "vec", "\u20E1": "vec", "\u0305": "bar", "\u0332": "underline",
  "\u030A": "ring", "\u0330": "utilde",
};

/** Accents drawn across every character of a multi-character body. */
export const SPANNING_ACCENTS = new Set(["overline", "underline", "bar", "underbar", "widetilde", "widehat"]);

/** Explicit spacing commands, in terminal columns. */
export const SPACES: Record<string, number> = {
  ",": 1, ":": 1, ">": 1, ";": 1, " ": 1, "!": 0, quad: 2, qquad: 4, enspace: 1, thinspace: 1,
  medspace: 1, thickspace: 1, negthinspace: 0, negmedspace: 0, negthickspace: 0, enskip: 1,
  space: 1, nobreakspace: 1,
};

/** Commands that only affect typesetting details invisible in a terminal. */
export const IGNORED_COMMANDS = new Set([
  "displaystyle", "textstyle", "scriptstyle", "scriptscriptstyle", "limits", "nolimits", "nonumber",
  "notag", "mathstrut", "strut", "allowbreak", "nobreak", "hfill", "hfil", "centering", "relax",
  "left.", "right.", "middle.", "big", "Big", "bigg", "Bigg", "bigl", "bigr", "Bigl", "Bigr",
  "biggl", "biggr", "Biggl", "Biggr", "bigm", "Bigm", "biggm", "Biggm", "hline", "midrule",
  "toprule", "bottomrule", "newline", "vfill", "smallskip", "medskip", "bigskip", "noindent",
  "tiny", "scriptsize", "footnotesize", "small", "normalsize", "large", "Large", "LARGE", "huge",
  "Huge", "rm", "it", "bf", "sf", "tt", "cal", "boldmath", "unboldmath", "mathchoice",
]);

/** Commands whose arguments are dropped entirely. */
export const DROPPED_WITH_ARGUMENT: Record<string, number> = {
  label: 1, color: 1, hspace: 1, vspace: 1, "hspace*": 1, "vspace*": 1, phantom: 1, hphantom: 1,
  vphantom: 1, cline: 1, cite: 1, rule: 2, raisebox: 1, setlength: 2,
};
