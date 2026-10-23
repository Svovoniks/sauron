import { test, expect, describe } from "bun:test";
import { splitSqlRanges, splitSqlStatements } from "./splitStatements";

const pg = (sql: string) => splitSqlStatements(sql, "postgres");
const ch = (sql: string) => splitSqlStatements(sql, "clickhouse");

describe("basics", () => {
  test("multiple statements", () => {
    expect(pg("select 1; select 2; select 3")).toEqual(["select 1", "select 2", "select 3"]);
    expect(ch("select 1; select 2")).toEqual(["select 1", "select 2"]);
  });

  test("trailing semicolon and no semicolon", () => {
    expect(pg("select 1;")).toEqual(["select 1"]);
    expect(pg("select 1")).toEqual(["select 1"]);
    expect(pg("select 1;\n")).toEqual(["select 1"]);
  });

  test("empty and whitespace-only input", () => {
    expect(pg("")).toEqual([]);
    expect(ch("")).toEqual([]);
    expect(pg("  \n\t ")).toEqual([]);
  });

  test("empty statements are dropped", () => {
    expect(pg(";;; select 1 ;; ; select 2;;")).toEqual(["select 1", "select 2"]);
  });

  test("statements are trimmed", () => {
    expect(pg("\n  select 1  \n;\n\n  select 2\n")).toEqual(["select 1", "select 2"]);
  });

  test("CRLF line endings", () => {
    expect(pg("select 1;\r\nselect 2;\r\n")).toEqual(["select 1", "select 2"]);
    expect(pg("select 1 -- c;\r\n;select 2\r\n")).toEqual(["select 1 -- c;", "select 2"]);
    expect(ch("select 1 # c;\r\n;select 2")).toEqual(["select 1 # c;", "select 2"]);
  });
});

describe("single-quoted strings", () => {
  test("semicolon inside string", () => {
    expect(pg("select 'a;b'; select 2")).toEqual(["select 'a;b'", "select 2"]);
    expect(ch("select 'a;b'; select 2")).toEqual(["select 'a;b'", "select 2"]);
  });

  test("doubled quote escape", () => {
    expect(pg("select 'it''s;'; select 2")).toEqual(["select 'it''s;'", "select 2"]);
    expect(ch("select 'it''s;'; select 2")).toEqual(["select 'it''s;'", "select 2"]);
  });

  test("backslash is an escape in clickhouse", () => {
    expect(ch("select 'it\\'s;'; select 2")).toEqual(["select 'it\\'s;'", "select 2"]);
    expect(ch("select '\\\\'; select 2")).toEqual(["select '\\\\'", "select 2"]);
  });

  test("backslash is NOT an escape in plain postgres strings", () => {
    // 'a\' is a complete string, so the ; after it splits.
    expect(pg("select 'a\\'; select 2")).toEqual(["select 'a\\'", "select 2"]);
  });

  test("backslash is an escape in postgres E strings", () => {
    expect(pg("select E'\\''; select 2")).toEqual(["select E'\\''", "select 2"]);
    expect(pg("select e'it\\'s;'; select 2")).toEqual(["select e'it\\'s;'", "select 2"]);
    expect(pg("select E'a\\\\'; select 2")).toEqual(["select E'a\\\\'", "select 2"]);
  });

  test("E prefix must be a standalone prefix in postgres", () => {
    // `name'...'` is not an E-string; the backslash is literal and the string ends at the second quote.
    expect(pg("select name'a\\'; select 2")).toEqual(["select name'a\\'", "select 2"]);
  });

  test("clickhouse treats '\\'' as one escaped quote", () => {
    expect(ch("select '\\''; select 2")).toEqual(["select '\\''", "select 2"]);
  });

  test("postgres '\\'' style differs from E'\\''", () => {
    // Plain string '\' then a lone quote opens a new string that swallows the rest.
    expect(pg("select '\\''; select 2")).toEqual(["select '\\''; select 2"]);
  });

  test("unterminated string swallows the rest", () => {
    expect(pg("select 1; select 'abc; select 3")).toEqual(["select 1", "select 'abc; select 3"]);
    expect(ch("select 'abc\\")).toEqual(["select 'abc\\"]);
  });
});

describe("quoted identifiers", () => {
  test("double quotes", () => {
    expect(pg('select "a;b" from t; select 2')).toEqual(['select "a;b" from t', "select 2"]);
    expect(pg('select "a""b;" from t; select 2')).toEqual(['select "a""b;" from t', "select 2"]);
    expect(ch('select "a;b"; select 2')).toEqual(['select "a;b"', "select 2"]);
  });

  test("clickhouse backslash in double quotes", () => {
    expect(ch('select "a\\";b"; select 2')).toEqual(['select "a\\";b"', "select 2"]);
  });

  test("postgres backslash in double quotes is literal", () => {
    expect(pg('select "a\\"; select 2')).toEqual(['select "a\\"', "select 2"]);
  });

  test("backticks in both dialects", () => {
    expect(ch("select `a;b`; select 2")).toEqual(["select `a;b`", "select 2"]);
    expect(pg("select `a;b`; select 2")).toEqual(["select `a;b`", "select 2"]);
    expect(ch("select `a``;b`; select 2")).toEqual(["select `a``;b`", "select 2"]);
    expect(ch("select `a\\`;b`; select 2")).toEqual(["select `a\\`;b`", "select 2"]);
  });

  test("unterminated identifier", () => {
    expect(pg('select "abc; select 2')).toEqual(['select "abc; select 2']);
    expect(ch("select `abc; select 2")).toEqual(["select `abc; select 2"]);
  });

  test("quote characters inside the other quote type", () => {
    expect(pg(`select '"'; select "'"`)).toEqual([`select '"'`, `select "'"`]);
  });
});

describe("line comments", () => {
  test("-- comment hides semicolon", () => {
    expect(pg("select 1 -- a; b\n; select 2")).toEqual(["select 1 -- a; b", "select 2"]);
    expect(ch("select 1 -- a; b\n; select 2")).toEqual(["select 1 -- a; b", "select 2"]);
  });

  test("comment ends at newline", () => {
    expect(pg("select 1 -- c\n, 2; select 3")).toEqual(["select 1 -- c\n, 2", "select 3"]);
  });

  test("quotes inside comments do not open strings", () => {
    expect(pg("select 1 -- it's\n; select 2")).toEqual(["select 1 -- it's", "select 2"]);
  });

  test("# comment in clickhouse", () => {
    expect(ch("select 1 # a; b\n; select 2")).toEqual(["select 1 # a; b", "select 2"]);
  });

  test("#! comment in clickhouse", () => {
    expect(ch("#!/usr/bin/env clickhouse; x\nselect 1; select 2")).toEqual([
      "#!/usr/bin/env clickhouse; x\nselect 1",
      "select 2",
    ]);
  });

  test("# is an operator in postgres, not a comment", () => {
    expect(pg("select 1 # 2; select 3")).toEqual(["select 1 # 2", "select 3"]);
    expect(pg("select '1' # '2'; select 3")).toEqual(["select '1' # '2'", "select 3"]);
  });

  test("comment kept with the statement that follows", () => {
    expect(pg("-- first\nselect 1; -- second\nselect 2")).toEqual(["-- first\nselect 1", "-- second\nselect 2"]);
  });

  test("single dash is not a comment", () => {
    expect(pg("select 1 - 2; select 3")).toEqual(["select 1 - 2", "select 3"]);
  });

  test("comment at EOF without newline", () => {
    expect(pg("select 1 -- end;")).toEqual(["select 1 -- end;"]);
  });
});

describe("block comments", () => {
  test("hides semicolon", () => {
    expect(pg("select 1 /* ; */; select 2")).toEqual(["select 1 /* ; */", "select 2"]);
    expect(ch("select 1 /* ; */; select 2")).toEqual(["select 1 /* ; */", "select 2"]);
  });

  test("multiline", () => {
    expect(pg("select /* a;\nb; */ 1; select 2")).toEqual(["select /* a;\nb; */ 1", "select 2"]);
  });

  test("nested in postgres", () => {
    expect(pg("select 1 /* a /* b; */ c; */; select 2")).toEqual(["select 1 /* a /* b; */ c; */", "select 2"]);
  });

  test("not nested in clickhouse", () => {
    // The comment ends at the first */, so the `c;` part is live SQL and splits.
    expect(ch("select 1 /* a /* b; */ c; */; select 2")).toEqual(["select 1 /* a /* b; */ c", "*/", "select 2"]);
  });

  test("unterminated block comment swallows the rest", () => {
    expect(pg("select 1; /* open; select 2")).toEqual(["select 1"]);
    expect(pg("select 1 /* open; select 2")).toEqual(["select 1 /* open; select 2"]);
    expect(pg("select 1 /* a /* b */ still open; select 2")).toEqual(["select 1 /* a /* b */ still open; select 2"]);
  });

  test("slash and star alone are operators", () => {
    expect(pg("select 4 / 2 * 3; select 1")).toEqual(["select 4 / 2 * 3", "select 1"]);
  });

  test("quotes inside block comments are ignored", () => {
    expect(pg("select 1 /* ' */; select 2")).toEqual(["select 1 /* ' */", "select 2"]);
  });
});

describe("dollar quoting (postgres)", () => {
  test("$$ ... $$", () => {
    expect(pg("select $$a;b$$; select 2")).toEqual(["select $$a;b$$", "select 2"]);
  });

  test("tagged", () => {
    expect(pg("select $tag$ a; $$ ; b $tag$; select 2")).toEqual(["select $tag$ a; $$ ; b $tag$", "select 2"]);
    expect(pg("select $_a1$x;y$_a1$; select 2")).toEqual(["select $_a1$x;y$_a1$", "select 2"]);
  });

  test("different tag does not close", () => {
    expect(pg("select $a$ x; $b$ y; $a$; select 2")).toEqual(["select $a$ x; $b$ y; $a$", "select 2"]);
  });

  test("function body", () => {
    const fn = "create function f() returns int as $body$ begin select 1; return 2; end; $body$ language plpgsql";
    expect(pg(`${fn}; select 3`)).toEqual([fn, "select 3"]);
  });

  test("positional parameters are not dollar quotes", () => {
    expect(pg("select $1; select $2")).toEqual(["select $1", "select $2"]);
    expect(pg("select $1, $2 from t where a = $1; select 3")).toEqual(["select $1, $2 from t where a = $1", "select 3"]);
  });

  test("dollar inside identifiers is not a quote", () => {
    expect(pg("select a$b$ from t; select 2")).toEqual(["select a$b$ from t", "select 2"]);
    expect(pg("select a$$ from t; select 2")).toEqual(["select a$$ from t", "select 2"]);
  });

  test("lone $ is harmless", () => {
    expect(pg("select 1 $ 2; select 3")).toEqual(["select 1 $ 2", "select 3"]);
  });

  test("unterminated dollar quote swallows the rest", () => {
    expect(pg("select 1; select $$ a; b")).toEqual(["select 1", "select $$ a; b"]);
    expect(pg("select $t$ a; $u$ b")).toEqual(["select $t$ a; $u$ b"]);
  });

  test("quotes and comments inside dollar quotes are ignored", () => {
    expect(pg("select $$ ' -- /* $$; select 2")).toEqual(["select $$ ' -- /* $$", "select 2"]);
  });

  test("$ is not special in clickhouse", () => {
    expect(ch("select $$a;b$$")).toEqual(["select $$a", "b$$"]);
    expect(ch("select $tag$a;b$tag$")).toEqual(["select $tag$a", "b$tag$"]);
  });
});

describe("comment-only chunks", () => {
  test("trailing comment is dropped", () => {
    expect(pg("select 1; -- done")).toEqual(["select 1"]);
    expect(pg("select 1;\n-- done\n")).toEqual(["select 1"]);
    expect(ch("select 1;\n# done\n")).toEqual(["select 1"]);
    expect(pg("select 1; /* done */")).toEqual(["select 1"]);
  });

  test("comment-only input", () => {
    expect(pg("-- nothing")).toEqual([]);
    expect(pg("/* nothing */")).toEqual([]);
    expect(pg("-- a\n/* b */\n-- c")).toEqual([]);
    expect(ch("# a\n#! b\n")).toEqual([]);
  });

  test("comment between semicolons", () => {
    expect(pg("select 1; -- x\n; select 2")).toEqual(["select 1", "select 2"]);
    expect(pg("select 1; /* x */ ; select 2")).toEqual(["select 1", "select 2"]);
  });

  test("# at the start is content in postgres", () => {
    expect(pg("# x")).toEqual(["# x"]);
  });

  test("empty quoted string counts as content", () => {
    expect(pg("''")).toEqual(["''"]);
    expect(pg('""')).toEqual(['""']);
  });
});

describe("mixed scripts", () => {
  test("realistic postgres script", () => {
    const sql = [
      "-- setup",
      "create table t (a text); -- trailing",
      "insert into t values ('x;y'), ($$z;$$);",
      "/* multi; line */ select * from t where a = 'it''s' ;",
      "-- done",
    ].join("\n");
    expect(pg(sql)).toEqual([
      "-- setup\ncreate table t (a text)",
      "-- trailing\ninsert into t values ('x;y'), ($$z;$$)",
      "/* multi; line */ select * from t where a = 'it''s'",
    ]);
  });

  test("realistic clickhouse script", () => {
    const sql = "select 'a\\';b' as x; # c;\nselect `y;` from t;";
    expect(ch(sql)).toEqual(["select 'a\\';b' as x", "# c;\nselect `y;` from t"]);
  });

  test("unicode content", () => {
    expect(pg("select 'привет;'; select 'мир'")).toEqual(["select 'привет;'", "select 'мир'"]);
  });

  test("never throws on odd input", () => {
    for (const s of ["'", '"', "`", "/*", "/", "-", "$", "$$", "$a", "$a$", "\\", "E'", "e'\\", "--", "#"]) {
      expect(() => pg(s)).not.toThrow();
      expect(() => ch(s)).not.toThrow();
    }
  });
});

describe("splitSqlRanges", () => {
  test("offsets point at the trimmed statement text", () => {
    const sql = "  select 1 ;\n\n-- note\nselect ';' from t;  \nselect 3";
    const ranges = splitSqlRanges(sql, "postgres");
    expect(ranges.map((r) => sql.slice(r.start, r.end))).toEqual(ranges.map((r) => r.text));
    expect(ranges.map((r) => r.text)).toEqual(["select 1", "-- note\nselect ';' from t", "select 3"]);
  });
  test("agrees with splitSqlStatements", () => {
    const sql = "select $$a;b$$; select 2;; select 3";
    expect(splitSqlRanges(sql, "postgres").map((r) => r.text)).toEqual(splitSqlStatements(sql, "postgres"));
  });
});
