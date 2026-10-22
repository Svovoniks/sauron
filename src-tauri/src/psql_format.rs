//! Text layout that matches psql's default `aligned` output, so `\dt`, `\d table` ... look the same
//! as in a terminal: centered title and headers, `-+-` rule, left aligned text, right aligned
//! numbers, `+` marking continued multi-line cells, `(N rows)` footer.

fn width(s: &str) -> usize {
    s.chars().count()
}

fn pad(n: usize) -> String {
    " ".repeat(n)
}

/// One column of an aligned table.
pub struct Column {
    pub header: String,
    /// Numbers are right aligned (the header stays centered), like psql does.
    pub right: bool,
}

impl Column {
    pub fn new(header: impl Into<String>, right: bool) -> Self {
        Column { header: header.into(), right }
    }
}

/// `None` (SQL NULL) prints as an empty cell, like psql.
pub fn aligned_table(
    title: Option<&str>,
    columns: &[Column],
    rows: &[Vec<Option<String>>],
    row_count_footer: bool,
) -> String {
    let cells: Vec<Vec<Vec<String>>> = rows
        .iter()
        .map(|row| {
            (0..columns.len())
                .map(|i| {
                    let text = row.get(i).and_then(|c| c.as_deref()).unwrap_or("");
                    text.split('\n').map(|l| l.trim_end_matches('\r').to_string()).collect()
                })
                .collect()
        })
        .collect();

    let widths: Vec<usize> = columns
        .iter()
        .enumerate()
        .map(|(i, col)| {
            let data = cells.iter().flat_map(|row| row[i].iter()).map(|l| width(l)).max().unwrap_or(0);
            width(&col.header).max(data)
        })
        .collect();

    let rule_width: usize = widths.iter().map(|w| w + 2).sum::<usize>() + columns.len().saturating_sub(1);
    let mut out = String::new();

    if let Some(title) = title {
        out.push_str(&pad(rule_width.saturating_sub(width(title)) / 2));
        out.push_str(title);
        out.push('\n');
    }

    // header: centered
    let header: Vec<String> = columns
        .iter()
        .zip(&widths)
        .map(|(col, w)| {
            let free = w - width(&col.header);
            let left = free / 2;
            format!(" {}{}{} ", pad(left), col.header, pad(free - left))
        })
        .collect();
    out.push_str(header.join("|").trim_end());
    out.push('\n');

    // rule
    out.push_str(&widths.iter().map(|w| "-".repeat(w + 2)).collect::<Vec<_>>().join("+"));
    out.push('\n');

    // rows
    for row in &cells {
        let height = row.iter().map(Vec::len).max().unwrap_or(1);
        for line in 0..height {
            let mut segments = Vec::with_capacity(columns.len());
            let mut last_marker = ' ';
            for (i, col) in columns.iter().enumerate() {
                let text = row[i].get(line).map(String::as_str).unwrap_or("");
                let free = widths[i] - width(text);
                let marker = if line + 1 < row[i].len() { '+' } else { ' ' };
                last_marker = marker;
                let body = if col.right {
                    format!("{}{}", pad(free), text)
                } else {
                    format!("{}{}", text, pad(free))
                };
                segments.push(format!(" {body}{marker}"));
            }
            let joined = segments.join("|");
            out.push_str(if last_marker == '+' { &joined } else { joined.trim_end() });
            out.push('\n');
        }
    }

    if row_count_footer {
        out.push_str(&format!("({} row{})\n", rows.len(), if rows.len() == 1 { "" } else { "s" }));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(cells: &[&str]) -> Vec<Option<String>> {
        cells.iter().map(|c| Some(c.to_string())).collect()
    }

    fn lines(l: &[&str]) -> String {
        l.iter().map(|s| format!("{s}\n")).collect()
    }

    #[test]
    fn matches_psql_for_a_relation_list() {
        let columns = [Column::new("Schema", false), Column::new("Name", false), Column::new("Type", false), Column::new("Owner", false)];
        let rows = [row(&["public", "users", "table", "app"]), row(&["public", "user_orders", "table", "app"])];
        let expected = lines(&[
            "          List of relations",
            " Schema |    Name     | Type  | Owner",
            "--------+-------------+-------+-------",
            " public | users       | table | app",
            " public | user_orders | table | app",
            "(2 rows)",
        ]);
        assert_eq!(aligned_table(Some("List of relations"), &columns, &rows, true), expected);
    }

    #[test]
    fn numbers_are_right_aligned_and_headers_centered() {
        let columns = [Column::new("Type", false), Column::new("Start", true), Column::new("Maximum", true), Column::new("Cycles?", false)];
        let rows = [row(&["bigint", "1", "9223372036854775807", "no"])];
        let expected = lines(&[
            "  Type  | Start |       Maximum       | Cycles?",
            "--------+-------+---------------------+---------",
            " bigint |     1 | 9223372036854775807 | no",
        ]);
        assert_eq!(aligned_table(None, &columns, &rows, false), expected);
    }

    #[test]
    fn multi_line_cells_continue_with_a_plus() {
        let columns = [Column::new("Name", false), Column::new("Access privileges", false)];
        let rows = [
            vec![Some("postgres".to_string()), None],
            vec![Some("template0".to_string()), Some("=c/postgres\npostgres=CTc/postgres".to_string())],
        ];
        let expected = lines(&[
            "   Name    |   Access privileges",
            "-----------+-----------------------",
            " postgres  |",
            " template0 | =c/postgres          +",
            "           | postgres=CTc/postgres",
            "(2 rows)",
        ]);
        assert_eq!(aligned_table(None, &columns, &rows, true), expected);
    }

    #[test]
    fn continuation_marker_in_a_middle_column() {
        let columns = [Column::new("A", false), Column::new("B", false)];
        let rows = [row(&["x\ny", "z"])];
        let expected = lines(&[" A | B", "---+---", " x+| z", " y |"]);
        assert_eq!(aligned_table(None, &columns, &rows, false), expected);
    }

    #[test]
    fn empty_result_and_singular_footer() {
        let columns = [Column::new("Name", false)];
        assert_eq!(aligned_table(None, &columns, &[], true), lines(&[" Name", "------", "(0 rows)"]));
        assert!(aligned_table(None, &columns, &[row(&["a"])], true).ends_with("(1 row)\n"));
    }
}
