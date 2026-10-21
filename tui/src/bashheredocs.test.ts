import { describe, expect, test } from "bun:test";
import { scanHeredocOperators, splitHeredocPieces, type CommandPiece } from "./bashheredocs";

function delimiters(line: string): string[] {
  return scanHeredocOperators(line).operators.map(operator => operator.delimiter);
}

function shape(pieces: CommandPiece[]): unknown[] {
  return pieces.map(piece => piece.type === "shell"
    ? { shell: piece.lines, ...(piece.continuationLines ? { continuationLines: piece.continuationLines } : {}) }
    : { delimiter: piece.operator.delimiter, body: piece.body, terminator: piece.terminator });
}

describe("heredoc operators", () => {
  test("accept unquoted, quoted, escaped and dash delimiters of any name", () => {
    expect(delimiters("cat <<EOF")).toEqual(["EOF"]);
    expect(delimiters("cat <<'END_OF_MESSAGE'")).toEqual(["END_OF_MESSAGE"]);
    expect(delimiters('cat << "PY"')).toEqual(["PY"]);
    expect(delimiters("cat <<\\EOF")).toEqual(["EOF"]);
    expect(delimiters("cat <<E'O'F")).toEqual(["EOF"]);
    const dash = scanHeredocOperators("cat <<-EOF").operators[0];
    expect(dash).toMatchObject({ delimiter: "EOF", stripTabs: true });
  });

  test("ignore here-strings, shifts, quoted text and comments", () => {
    expect(delimiters('cat <<< "hello"')).toEqual([]);
    expect(delimiters("echo $((1<<2))")).toEqual([]);
    expect(delimiters('echo "a << b" \'c <<d\'')).toEqual([]);
    expect(delimiters("ls # cat <<EOF")).toEqual([]);
  });

  test("find heredocs inside command substitutions, even in double quotes", () => {
    const [operator] = scanHeredocOperators(`git commit -m "$(cat <<'EOF'`).operators;
    expect(operator).toMatchObject({ delimiter: "EOF", inSubstitution: true });
    expect(`git commit -m "$(cat <<'EOF'`.slice(operator.commandStart)).toBe("cat <<'EOF'");
    expect(operator.outerCommandStart).toBe(0);
  });

  test("record the simple command that owns each operator", () => {
    const line = "D=~/x; cat <<'EOF' 2>&1 | discord send 1 && python3 - <<'PY'";
    const operators = scanHeredocOperators(line).operators;
    expect(operators.map(operator => line.slice(operator.commandStart, operator.start).trim())).toEqual(["cat", "python3 -"]);
  });
});

describe("heredoc pieces", () => {
  test("a command without heredocs is one shell piece", () => {
    expect(shape(splitHeredocPieces("ls\necho hi"))).toEqual([{ shell: ["ls", "echo hi"] }]);
  });

  test("bodies are split from the shell lines around them", () => {
    const command = "cat <<'EOF' | discord send 1\n**Title**\n• one\nEOF\ncd ~/y; python3 - <<'PY'\nprint(1)\nPY\necho done";
    expect(shape(splitHeredocPieces(command))).toEqual([
      { shell: ["cat <<'EOF' | discord send 1"] },
      { delimiter: "EOF", body: ["**Title**", "• one"], terminator: "EOF" },
      { shell: ["cd ~/y; python3 - <<'PY'"] },
      { delimiter: "PY", body: ["print(1)"], terminator: "PY" },
      { shell: ["echo done"] },
    ]);
  });

  test("several heredocs on one line take their bodies in order", () => {
    expect(shape(splitHeredocPieces("cat <<A > a.txt; cat <<B > b.txt\none\nA\ntwo\nB"))).toEqual([
      { shell: ["cat <<A > a.txt; cat <<B > b.txt"] },
      { delimiter: "A", body: ["one"], terminator: "A" },
      { delimiter: "B", body: ["two"], terminator: "B" },
    ]);
  });

  test("only an exact delimiter line closes the body", () => {
    expect(shape(splitHeredocPieces("cat <<EOF\nEOF is coming\n EOF\nEOF \nEOF2\nEOF"))).toEqual([
      { shell: ["cat <<EOF"] },
      { delimiter: "EOF", body: ["EOF is coming", " EOF", "EOF ", "EOF2"], terminator: "EOF" },
    ]);
  });

  test("<<- closes on a tab-indented delimiter (tabs arrive sanitized to spaces)", () => {
    expect(shape(splitHeredocPieces("  cat <<-EOF\n    body\n    EOF\necho after"))).toEqual([
      { shell: ["  cat <<-EOF"] },
      { delimiter: "EOF", body: ["    body"], terminator: "    EOF" },
      { shell: ["echo after"] },
    ]);
    expect(splitHeredocPieces("cat <<EOF\n    EOF\nEOF")[1]).toMatchObject({ body: ["    EOF"], terminator: "EOF" });
  });

  test("lines after a heredoc opened inside a quote finish that command", () => {
    expect(shape(splitHeredocPieces(`git commit -m "$(cat <<'EOF'\nSubject\nEOF\n)"\ngit push`))).toEqual([
      { shell: [`git commit -m "$(cat <<'EOF'`] },
      { delimiter: "EOF", body: ["Subject"], terminator: "EOF" },
      { shell: [`)"`, "git push"], continuationLines: 1 },
    ]);
  });

  test("an unterminated body runs to the end of the command", () => {
    expect(shape(splitHeredocPieces("cat <<EOF\nstill going"))).toEqual([
      { shell: ["cat <<EOF"] },
      { delimiter: "EOF", body: ["still going"], terminator: null },
    ]);
  });
});
