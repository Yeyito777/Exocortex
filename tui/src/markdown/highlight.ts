// Lightweight regex-based syntax highlighter for terminal code blocks.
// Produces ANSI-colored strings for common programming languages.
// Designed for visual scanning in a TUI — not a full parser.
// Ported from Mnemo project (https://github.com/yeyito/Mnemo)

// --- ANSI Color Constants (Exocortex Whale Theme) ---
const FG_WHITE = "\x1b[38;2;255;255;255m";
const FG_SYN_KEYWORD = "\x1b[38;2;199;146;234m";   // #c792ea soft purple
const FG_SYN_STRING = "\x1b[38;2;195;232;141m";     // #c3e88d warm green
const FG_SYN_COMMENT = "\x1b[38;2;95;105;120m";     // #5f6978 muted gray
const FG_SYN_NUMBER = "\x1b[38;2;247;140;108m";     // #f78c6c warm orange
const FG_SYN_TYPE = "\x1b[38;2;137;221;255m";       // #89ddff soft cyan
const FG_SYN_FUNCTION = "\x1b[38;2;130;170;255m";   // #82aaff soft blue
const FG_SYN_OPERATOR = "\x1b[38;2;137;221;255m";   // #89ddff cyan
const FG_SYN_PUNCT = "\x1b[38;2;180;180;180m";      // #b4b4b4 light gray

export type TokenType =
  | "keyword" | "string" | "comment" | "number"
  | "type" | "function" | "operator" | "punct" | "default";

const TOKEN_COLORS: Record<TokenType, string> = {
  keyword: FG_SYN_KEYWORD,
  string: FG_SYN_STRING,
  comment: FG_SYN_COMMENT,
  number: FG_SYN_NUMBER,
  type: FG_SYN_TYPE,
  function: FG_SYN_FUNCTION,
  operator: FG_SYN_OPERATOR,
  punct: FG_SYN_PUNCT,
  default: FG_WHITE,
};

interface TokenRule {
  pattern: RegExp;
  type: TokenType;
}

// --- Language definitions ---
// Rules are tried in order — first match wins.
// Comments and strings come first to protect their contents.

const TYPESCRIPT_RULES: TokenRule[] = [
  // Comments
  { pattern: /\/\/.*$/y, type: "comment" },
  { pattern: /\/\*[\s\S]*?\*\//y, type: "comment" },
  // Strings (double, single, backtick)
  { pattern: /"(?:[^"\\]|\\.)*"/y, type: "string" },
  { pattern: /'(?:[^'\\]|\\.)*'/y, type: "string" },
  { pattern: /`(?:[^`\\]|\\.)*`/y, type: "string" },
  // Numbers
  { pattern: /\b0[xX][0-9a-fA-F]+\b/y, type: "number" },
  { pattern: /\b0[oO][0-7]+\b/y, type: "number" },
  { pattern: /\b0[bB][01]+\b/y, type: "number" },
  { pattern: /\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?n?\b/y, type: "number" },
  // Types (common built-in types)
  { pattern: /\b(?:string|number|boolean|void|any|never|unknown|null|undefined|object|symbol|bigint|Array|Map|Set|Record|Promise|Partial|Required|Readonly|Pick|Omit)\b/y, type: "type" },
  // Keywords
  { pattern: /\b(?:function|const|let|var|if|else|return|while|for|do|switch|case|break|continue|throw|try|catch|finally|new|delete|typeof|instanceof|in|of|class|extends|implements|interface|type|enum|namespace|module|import|export|from|default|as|async|await|yield|static|get|set|public|private|protected|readonly|abstract|declare|override|satisfies|this|super|true|false|null|undefined|void)\b/y, type: "keyword" },
  // Function calls (word followed by open paren)
  { pattern: /\b[a-zA-Z_$][\w$]*(?=\s*\()/y, type: "function" },
  // Arrow / spread / comparison / assignment operators
  { pattern: /=>|\.{3}|[!=]==?|[<>]=?|&&|\|\||[+\-*/%]=?|\?\?|[?!]\.?|[~^&|]=?|<<=?|>>>?=?/y, type: "operator" },
  // Punctuation
  { pattern: /[{}()[\];,.:@#]/y, type: "punct" },
];

const PYTHON_RULES: TokenRule[] = [
  // Comments
  { pattern: /#.*$/y, type: "comment" },
  // Triple-quoted strings (must come before single-quoted)
  { pattern: /"""[\s\S]*?"""/y, type: "string" },
  { pattern: /'''[\s\S]*?'''/y, type: "string" },
  // Strings
  { pattern: /[fFrRbBuU]?"(?:[^"\\]|\\.)*"/y, type: "string" },
  { pattern: /[fFrRbBuU]?'(?:[^'\\]|\\.)*'/y, type: "string" },
  // Numbers
  { pattern: /\b0[xX][0-9a-fA-F_]+\b/y, type: "number" },
  { pattern: /\b0[oO][0-7_]+\b/y, type: "number" },
  { pattern: /\b0[bB][01_]+\b/y, type: "number" },
  { pattern: /\b\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?\d+)?j?\b/y, type: "number" },
  // Types / built-in types
  { pattern: /\b(?:int|float|str|bool|list|dict|tuple|set|frozenset|bytes|bytearray|memoryview|complex|NoneType|type|object)\b/y, type: "type" },
  // Keywords
  { pattern: /\b(?:def|class|if|elif|else|return|while|for|in|not|and|or|is|with|as|try|except|finally|raise|import|from|yield|lambda|pass|break|continue|del|global|nonlocal|assert|async|await|True|False|None|self|cls)\b/y, type: "keyword" },
  // Decorators
  { pattern: /@\w+/y, type: "function" },
  // Function calls
  { pattern: /\b[a-zA-Z_]\w*(?=\s*\()/y, type: "function" },
  // Operators
  { pattern: /\*\*|\/\/|[+\-*/%@]=?|[<>]=?|[!=]=|<<=?|>>=?|[&|^~]/y, type: "operator" },
  // Punctuation
  { pattern: /[{}()[\];,.:->]/y, type: "punct" },
];

const RUST_RULES: TokenRule[] = [
  // Comments
  { pattern: /\/\/.*$/y, type: "comment" },
  { pattern: /\/\*[\s\S]*?\*\//y, type: "comment" },
  // Strings
  { pattern: /"(?:[^"\\]|\\.)*"/y, type: "string" },
  { pattern: /b"(?:[^"\\]|\\.)*"/y, type: "string" },
  { pattern: /'[^'\\]'|'\\.'/y, type: "string" },
  // Numbers
  { pattern: /\b0[xX][0-9a-fA-F_]+(?:_?[iu](?:8|16|32|64|128|size))?\b/y, type: "number" },
  { pattern: /\b0[oO][0-7_]+(?:_?[iu](?:8|16|32|64|128|size))?\b/y, type: "number" },
  { pattern: /\b0[bB][01_]+(?:_?[iu](?:8|16|32|64|128|size))?\b/y, type: "number" },
  { pattern: /\b\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?\d+)?(?:_?(?:f32|f64|[iu](?:8|16|32|64|128|size)))?\b/y, type: "number" },
  // Types
  { pattern: /\b(?:i8|i16|i32|i64|i128|isize|u8|u16|u32|u64|u128|usize|f32|f64|bool|char|str|String|Vec|Box|Rc|Arc|Option|Result|HashMap|HashSet|BTreeMap|BTreeSet|Cow|Pin|Cell|RefCell|Mutex|RwLock)\b/y, type: "type" },
  // Lifetimes
  { pattern: /'[a-zA-Z_]\w*/y, type: "type" },
  // Keywords
  { pattern: /\b(?:fn|let|mut|const|static|if|else|match|loop|while|for|in|break|continue|return|struct|enum|impl|trait|type|use|mod|pub|crate|super|self|Self|where|as|ref|move|async|await|dyn|unsafe|extern|true|false|macro_rules)\b/y, type: "keyword" },
  // Macros
  { pattern: /\b[a-zA-Z_]\w*!/y, type: "function" },
  // Function calls
  { pattern: /\b[a-zA-Z_]\w*(?=\s*[(<])/y, type: "function" },
  // Operators
  { pattern: /=>|->|\.{2,3}|&&|\|\||[!=]=|[<>]=?|[+\-*/%&|^!]=?|<<=?|>>=?/y, type: "operator" },
  // Punctuation
  { pattern: /[{}()[\];,.:@#]/y, type: "punct" },
];

const GO_RULES: TokenRule[] = [
  // Comments
  { pattern: /\/\/.*$/y, type: "comment" },
  { pattern: /\/\*[\s\S]*?\*\//y, type: "comment" },
  // Strings
  { pattern: /"(?:[^"\\]|\\.)*"/y, type: "string" },
  { pattern: /`[^`]*`/y, type: "string" },
  { pattern: /'[^'\\]'|'\\.'/y, type: "string" },
  // Numbers
  { pattern: /\b0[xX][0-9a-fA-F_]+\b/y, type: "number" },
  { pattern: /\b0[oO][0-7_]+\b/y, type: "number" },
  { pattern: /\b0[bB][01_]+\b/y, type: "number" },
  { pattern: /\b\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?\d+)?i?\b/y, type: "number" },
  // Types
  { pattern: /\b(?:int|int8|int16|int32|int64|uint|uint8|uint16|uint32|uint64|uintptr|float32|float64|complex64|complex128|bool|byte|rune|string|error|any)\b/y, type: "type" },
  // Keywords
  { pattern: /\b(?:func|var|const|type|struct|interface|map|chan|if|else|switch|case|default|for|range|break|continue|return|go|defer|select|package|import|fallthrough|goto|nil|true|false|iota|make|new|append|len|cap|copy|delete|close|panic|recover|print|println)\b/y, type: "keyword" },
  // Function calls
  { pattern: /\b[a-zA-Z_]\w*(?=\s*\()/y, type: "function" },
  // Operators
  { pattern: /:=|<-|&&|\|\||[!=]=|[<>]=?|[+\-*/%&|^]=?|&\^=?|<<=?|>>=?|\.{3}/y, type: "operator" },
  // Punctuation
  { pattern: /[{}()[\];,.:@]/y, type: "punct" },
];

const BASH_RULES: TokenRule[] = [
  // Comments
  { pattern: /#.*$/y, type: "comment" },
  // Strings
  { pattern: /"(?:[^"\\]|\\.)*"/y, type: "string" },
  { pattern: /'[^']*'/y, type: "string" },
  { pattern: /\$'(?:[^'\\]|\\.)*'/y, type: "string" },
  // Variables
  { pattern: /\$\{[^}]+\}/y, type: "type" },
  { pattern: /\$[a-zA-Z_]\w*/y, type: "type" },
  { pattern: /\$[0-9@#?$!*-]/y, type: "type" },
  // Numbers
  { pattern: /\b\d+(?:\.\d+)?\b/y, type: "number" },
  // Keywords
  { pattern: /\b(?:if|then|else|elif|fi|case|esac|for|while|until|do|done|in|function|return|exit|local|export|readonly|declare|typeset|unset|source|eval|exec|set|shift|trap|wait|true|false|select)\b/y, type: "keyword" },
  // Common commands (highlight like functions)
  { pattern: /\b(?:echo|printf|cd|ls|cat|grep|sed|awk|find|xargs|sort|uniq|wc|head|tail|cut|tr|tee|mkdir|rmdir|rm|cp|mv|ln|chmod|chown|chgrp|touch|test|read|curl|wget|git|docker|make|sudo|pip|npm|bun|yarn|cargo|go|python|node)\b/y, type: "function" },
  // Operators
  { pattern: /\|\||&&|;;|[<>]=?|[!=]=?|[|&;]/y, type: "operator" },
  // Punctuation
  { pattern: /[{}()[\],]/y, type: "punct" },
];

const JSON_RULES: TokenRule[] = [
  // Strings (keys and values)
  { pattern: /"(?:[^"\\]|\\.)*"\s*(?=:)/y, type: "type" },     // keys
  { pattern: /"(?:[^"\\]|\\.)*"/y, type: "string" },            // values
  // Numbers
  { pattern: /-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/y, type: "number" },
  // Keywords
  { pattern: /\b(?:true|false|null)\b/y, type: "keyword" },
  // Punctuation
  { pattern: /[{}[\]:,]/y, type: "punct" },
];

const YAML_RULES: TokenRule[] = [
  // Comments
  { pattern: /#.*$/y, type: "comment" },
  // Keys (word followed by colon)
  { pattern: /^[\w.-]+(?=\s*:)/y, type: "type" },
  { pattern: /^\s+[\w.-]+(?=\s*:)/y, type: "type" },
  // Strings
  { pattern: /"(?:[^"\\]|\\.)*"/y, type: "string" },
  { pattern: /'(?:[^'\\]|\\.)*'/y, type: "string" },
  // Numbers
  { pattern: /\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/y, type: "number" },
  // Keywords
  { pattern: /\b(?:true|false|null|yes|no|on|off)\b/y, type: "keyword" },
  // Document markers
  { pattern: /^---$|^\.\.\.$/my, type: "operator" },
  // Anchors & aliases
  { pattern: /[&*]\w+/y, type: "function" },
  // Tags
  { pattern: /!\S+/y, type: "type" },
  // Punctuation
  { pattern: /[[\]{},:|>-]/y, type: "punct" },
];

const HTML_RULES: TokenRule[] = [
  // Comments
  { pattern: /<!--[\s\S]*?-->/y, type: "comment" },
  // Doctype
  { pattern: /<!DOCTYPE\s[^>]+>/iy, type: "keyword" },
  // Tags (opening/closing)
  { pattern: /<\/?[a-zA-Z][\w-]*/y, type: "keyword" },
  { pattern: /\/?>/y, type: "keyword" },
  // Attribute names
  { pattern: /\b[a-zA-Z][\w-]*(?==)/y, type: "type" },
  // Strings (attribute values)
  { pattern: /"(?:[^"\\]|\\.)*"/y, type: "string" },
  { pattern: /'(?:[^'\\]|\\.)*'/y, type: "string" },
  // Entities
  { pattern: /&\w+;|&#\d+;|&#x[0-9a-fA-F]+;/y, type: "number" },
  // Punctuation
  { pattern: /[=]/y, type: "punct" },
];

const CSS_RULES: TokenRule[] = [
  // Comments
  { pattern: /\/\*[\s\S]*?\*\//y, type: "comment" },
  // Strings
  { pattern: /"(?:[^"\\]|\\.)*"/y, type: "string" },
  { pattern: /'(?:[^'\\]|\\.)*'/y, type: "string" },
  // Numbers and units
  { pattern: /-?\b\d+(?:\.\d+)?(?:px|em|rem|%|vh|vw|vmin|vmax|ch|ex|cm|mm|in|pt|pc|s|ms|deg|rad|grad|turn|fr)?\b/y, type: "number" },
  // Hex colors
  { pattern: /#[0-9a-fA-F]{3,8}\b/y, type: "number" },
  // At-rules
  { pattern: /@[a-zA-Z][\w-]*/y, type: "keyword" },
  // Property names (word followed by colon)
  { pattern: /[a-zA-Z-]+(?=\s*:)/y, type: "type" },
  // Pseudo-classes/elements
  { pattern: /::?[a-zA-Z][\w-]*/y, type: "function" },
  // Selectors: class, id
  { pattern: /[.#][a-zA-Z][\w-]*/y, type: "function" },
  // Keywords
  { pattern: /\b(?:important|inherit|initial|unset|none|auto|normal|bold|italic)\b/y, type: "keyword" },
  // !important
  { pattern: /!important/y, type: "keyword" },
  // Functions
  { pattern: /\b[a-zA-Z][\w-]*(?=\()/y, type: "function" },
  // Punctuation
  { pattern: /[{}();:,>+~*[\]=]/y, type: "punct" },
];

const SQL_RULES: TokenRule[] = [
  // Comments
  { pattern: /--.*$/y, type: "comment" },
  { pattern: /\/\*[\s\S]*?\*\//y, type: "comment" },
  // Strings
  { pattern: /'(?:[^'\\]|\\.)*'/y, type: "string" },
  { pattern: /"(?:[^"\\]|\\.)*"/y, type: "string" },
  // Numbers
  { pattern: /\b\d+(?:\.\d+)?\b/y, type: "number" },
  // Keywords (case-insensitive)
  { pattern: /\b(?:SELECT|FROM|WHERE|AND|OR|NOT|IN|IS|NULL|AS|ON|JOIN|LEFT|RIGHT|INNER|OUTER|FULL|CROSS|UNION|ALL|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|TABLE|INDEX|VIEW|DROP|ALTER|ADD|COLUMN|PRIMARY|KEY|FOREIGN|REFERENCES|UNIQUE|CHECK|DEFAULT|CONSTRAINT|ORDER|BY|GROUP|HAVING|LIMIT|OFFSET|ASC|DESC|DISTINCT|BETWEEN|LIKE|EXISTS|CASE|WHEN|THEN|ELSE|END|CAST|COALESCE|NULLIF|COUNT|SUM|AVG|MIN|MAX|BEGIN|COMMIT|ROLLBACK|TRANSACTION|GRANT|REVOKE|WITH|RECURSIVE|RETURNING|CONFLICT|DO|NOTHING|EXCEPT|INTERSECT|FETCH|NEXT|ROWS|ONLY|IF|REPLACE|TEMPORARY|TEMP|CASCADE|RESTRICT|TRUNCATE|EXPLAIN|ANALYZE|VACUUM|REINDEX|TRIGGER|PROCEDURE|FUNCTION|SCHEMA|DATABASE|USE|SHOW|DESCRIBE)\b/iy, type: "keyword" },
  // Types
  { pattern: /\b(?:INT|INTEGER|BIGINT|SMALLINT|TINYINT|FLOAT|DOUBLE|DECIMAL|NUMERIC|REAL|BOOLEAN|BOOL|CHAR|VARCHAR|TEXT|BLOB|DATE|TIME|DATETIME|TIMESTAMP|SERIAL|UUID|JSON|JSONB|ARRAY|BYTEA|MONEY|INTERVAL|POINT|LINE|CIRCLE|POLYGON)\b/iy, type: "type" },
  // Functions
  { pattern: /\b[a-zA-Z_]\w*(?=\s*\()/y, type: "function" },
  // Operators
  { pattern: /[<>!=]+|::|&&|\|\|/y, type: "operator" },
  // Punctuation
  { pattern: /[{}()[\];,.*]/y, type: "punct" },
];

const C_RULES: TokenRule[] = [
  // Comments
  { pattern: /\/\/.*$/y, type: "comment" },
  { pattern: /\/\*[\s\S]*?\*\//y, type: "comment" },
  // Preprocessor directives
  { pattern: /^\s*#\s*\w+.*$/my, type: "function" },
  // Strings
  { pattern: /"(?:[^"\\]|\\.)*"/y, type: "string" },
  { pattern: /'(?:[^'\\]|\\.)*'/y, type: "string" },
  // Numbers
  { pattern: /\b0[xX][0-9a-fA-F]+[uUlL]*\b/y, type: "number" },
  { pattern: /\b0[bB][01]+[uUlL]*\b/y, type: "number" },
  { pattern: /\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?[fFlLuU]*\b/y, type: "number" },
  // Types
  { pattern: /\b(?:int|long|short|char|float|double|void|unsigned|signed|bool|size_t|ssize_t|ptrdiff_t|intptr_t|uintptr_t|int8_t|int16_t|int32_t|int64_t|uint8_t|uint16_t|uint32_t|uint64_t|FILE|wchar_t|auto|string|vector|map|set|unique_ptr|shared_ptr|optional|variant|tuple|array|pair|nullptr_t)\b/y, type: "type" },
  // Keywords
  { pattern: /\b(?:if|else|while|for|do|switch|case|default|break|continue|return|goto|typedef|struct|union|enum|class|template|typename|namespace|using|public|private|protected|virtual|override|final|static|extern|inline|const|constexpr|consteval|volatile|register|mutable|explicit|friend|operator|new|delete|throw|try|catch|noexcept|sizeof|alignof|decltype|static_cast|dynamic_cast|reinterpret_cast|const_cast|static_assert|concept|requires|co_await|co_yield|co_return|true|false|nullptr|NULL|this)\b/y, type: "keyword" },
  // Function calls
  { pattern: /\b[a-zA-Z_]\w*(?=\s*[(<])/y, type: "function" },
  // Operators
  { pattern: /->|::|\.\.\.|&&|\|\||[!=<>]=?|[+\-*/%&|^~]=?|<<=?|>>=?|\+\+|--/y, type: "operator" },
  // Punctuation
  { pattern: /[{}()[\];,.:?#]/y, type: "punct" },
];

const TOML_RULES: TokenRule[] = [
  // Comments
  { pattern: /#.*$/y, type: "comment" },
  // Strings
  { pattern: /"""[\s\S]*?"""/y, type: "string" },
  { pattern: /'''[\s\S]*?'''/y, type: "string" },
  { pattern: /"(?:[^"\\]|\\.)*"/y, type: "string" },
  { pattern: /'[^']*'/y, type: "string" },
  // Section headers
  { pattern: /^\s*\[\[?[\w.-]+\]?\]/my, type: "keyword" },
  // Keys
  { pattern: /^[\w.-]+(?=\s*=)/my, type: "type" },
  // Numbers / dates
  { pattern: /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?\b/y, type: "number" },
  { pattern: /[+-]?\b\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?\d+)?\b/y, type: "number" },
  { pattern: /\b0[xX][0-9a-fA-F_]+\b/y, type: "number" },
  { pattern: /\b0[oO][0-7_]+\b/y, type: "number" },
  { pattern: /\b0[bB][01_]+\b/y, type: "number" },
  // Keywords
  { pattern: /\b(?:true|false|inf|nan)\b/y, type: "keyword" },
  // Punctuation
  { pattern: /[[\]{}=,.]/y, type: "punct" },
];

const DIFF_RULES: TokenRule[] = [
  // File headers
  { pattern: /^(?:---|\+\+\+) .*$/my, type: "keyword" },
  { pattern: /^diff --.*$/my, type: "keyword" },
  { pattern: /^index [0-9a-f]+\.\.[0-9a-f]+.*$/my, type: "comment" },
  // Hunk headers
  { pattern: /^@@.*@@.*$/my, type: "type" },
  // Added lines
  { pattern: /^\+.*$/my, type: "string" },
  // Removed lines
  { pattern: /^-.*$/my, type: "number" },
];

const MARKDOWN_RULES: TokenRule[] = [
  // Headings
  { pattern: /^#{1,6}\s+.*$/my, type: "keyword" },
  // Code spans
  { pattern: /`[^`]+`/y, type: "string" },
  // Bold
  { pattern: /\*\*[^*]+\*\*/y, type: "keyword" },
  // Italic
  { pattern: /\*[^*]+\*/y, type: "type" },
  // Links
  { pattern: /\[([^\]]+)\]\([^)]+\)/y, type: "function" },
  // URLs
  { pattern: /https?:\/\/\S+/y, type: "function" },
  // List markers
  { pattern: /^\s*[-*+]\s/my, type: "operator" },
  { pattern: /^\s*\d+\.\s/my, type: "operator" },
  // Block quotes
  { pattern: /^\s*>+/my, type: "comment" },
  // Horizontal rules
  { pattern: /^[-*_]{3,}\s*$/my, type: "operator" },
];

// --- Language alias map ---

const LANGUAGE_MAP: Record<string, TokenRule[]> = {
  // TypeScript / JavaScript
  typescript: TYPESCRIPT_RULES,
  ts: TYPESCRIPT_RULES,
  javascript: TYPESCRIPT_RULES,
  js: TYPESCRIPT_RULES,
  jsx: TYPESCRIPT_RULES,
  tsx: TYPESCRIPT_RULES,
  mjs: TYPESCRIPT_RULES,
  cjs: TYPESCRIPT_RULES,

  // Python
  python: PYTHON_RULES,
  py: PYTHON_RULES,

  // Rust
  rust: RUST_RULES,
  rs: RUST_RULES,

  // Go
  go: GO_RULES,
  golang: GO_RULES,

  // Shell / Bash
  bash: BASH_RULES,
  sh: BASH_RULES,
  shell: BASH_RULES,
  zsh: BASH_RULES,
  fish: BASH_RULES,
  console: BASH_RULES,

  // JSON
  json: JSON_RULES,
  jsonc: JSON_RULES,
  json5: JSON_RULES,

  // YAML
  yaml: YAML_RULES,
  yml: YAML_RULES,

  // HTML / XML
  html: HTML_RULES,
  htm: HTML_RULES,
  xml: HTML_RULES,
  svg: HTML_RULES,
  vue: HTML_RULES,
  svelte: HTML_RULES,

  // CSS
  css: CSS_RULES,
  scss: CSS_RULES,
  sass: CSS_RULES,
  less: CSS_RULES,

  // SQL
  sql: SQL_RULES,
  psql: SQL_RULES,
  mysql: SQL_RULES,
  sqlite: SQL_RULES,
  pgsql: SQL_RULES,
  plpgsql: SQL_RULES,

  // C / C++
  c: C_RULES,
  cpp: C_RULES,
  "c++": C_RULES,
  cc: C_RULES,
  cxx: C_RULES,
  h: C_RULES,
  hpp: C_RULES,
  "h++": C_RULES,
  hh: C_RULES,
  hxx: C_RULES,

  // Java / Kotlin / C# / Swift (close enough to C/TS rules)
  java: C_RULES,
  kotlin: C_RULES,
  kt: C_RULES,
  csharp: C_RULES,
  cs: C_RULES,
  swift: C_RULES,

  // TOML
  toml: TOML_RULES,

  // Diff / Patch
  diff: DIFF_RULES,
  patch: DIFF_RULES,

  // Markdown
  markdown: MARKDOWN_RULES,
  md: MARKDOWN_RULES,
};

/**
 * Highlight a single line of source code.
 * Returns the line with ANSI color escapes applied.
 * If the language is not recognized, returns the line with FG_WHITE.
 */
export function highlightLine(line: string, language: string): string {
  const rules = LANGUAGE_MAP[language.toLowerCase()];
  if (!rules) return FG_WHITE + line;

  return tokenize(line, rules);
}

/**
 * Check if a language is supported for highlighting.
 */
export function isLanguageSupported(language: string): boolean {
  return language.toLowerCase() in LANGUAGE_MAP;
}

/**
 * Tokenize a line using the given rules and return ANSI-colored output.
 *
 * Works by scanning left-to-right: at each position, try each rule in
 * order.  First match wins — emit colored text, advance past the match.
 * Unmatched characters are emitted with FG_WHITE.
 *
 * Uses sticky (`y`) regexes matched against the full line so that `\b`
 * word-boundary assertions see the real surrounding characters.  Without
 * this, `.slice(pos)` causes `\b` to treat the slice boundary as a word
 * boundary, matching keywords inside longer words (e.g. `class` inside
 * `dataclass`, `in` inside `origin`).
 */
function tokenize(line: string, rules: TokenRule[]): string {
  let result = "";
  let pos = 0;
  let pendingDefault = "";

  while (pos < line.length) {
    let matched = false;

    for (const rule of rules) {
      rule.pattern.lastIndex = pos;
      const m = rule.pattern.exec(line);

      if (m && m.index === pos) {
        // Flush any pending default text
        if (pendingDefault) {
          result += FG_WHITE + pendingDefault;
          pendingDefault = "";
        }

        result += TOKEN_COLORS[rule.type] + m[0];
        pos += m[0].length;
        matched = true;
        break;
      }
    }

    if (!matched) {
      pendingDefault += line[pos];
      pos++;
    }
  }

  // Flush remaining default text
  if (pendingDefault) {
    result += FG_WHITE + pendingDefault;
  }

  return result;
}
