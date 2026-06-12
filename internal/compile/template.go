package compile

import (
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// expandTemplate substitutes `${expression}` placeholders in the
// source before handing it to marp-cli / pandoc / pdflatex. Mirrors
// the in-browser preview's templateExpr.ts so the rendered PDF and
// the live preview agree on the same output.
//
// Why server-side too : the in-browser preview is one renderer ; the
// real artifact is produced by marp-cli running inside the workspace
// μVM, which would otherwise see the raw `${...}` text and print it
// literally on the slide. Doing the substitution here keeps the two
// renderers in lock-step.
//
// Scope of evaluation : a deliberately narrow whitelist of pure,
// non-mutating ECMAScript expressions — Date / Math / arithmetic —
// rather than embedding a full JS engine (goja, otto). Real expressions
// authors actually write in slide front-matter are :
//
//   ${ new Date().getFullYear() }
//   ${ new Date().toISOString() }
//   ${ new Date().toLocaleDateString('fr-FR') }
//   ${ Math.PI.toFixed(4) }
//   ${ Math.round(Math.random() * 100) }     ← rejected (not pure)
//
// The first four resolve here ; unknown expressions are left as
// `${...}` so the author sees the placeholder rather than a silent
// "undefined". The browser preview falls back identically.
//
// Escape : `$${literal}` → `${literal}` (drops the leading `$`).

var (
	// `${ <body> }` with balanced top-level braces. Capture group 1 is
	// the inner expression text (whitespace-trimmed by the evaluator).
	rePlaceholder = regexp.MustCompile(`\$\{([^{}]*)\}`)
	// `$${...}` escape — has to be unwrapped after substitution.
	reEscape = regexp.MustCompile(`\$\$\{([^{}]*)\}`)

	reMathConst       = regexp.MustCompile(`^Math\.(PI|E|LN2|LN10|LOG2E|LOG10E|SQRT2)$`)
	reMathFunc        = regexp.MustCompile(`^Math\.(round|floor|ceil|abs|sqrt|log|exp|sin|cos|tan)\(\s*(-?[\d.]+)\s*\)$`)
	reMathPow         = regexp.MustCompile(`^Math\.pow\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)$`)
	reDateMethod      = regexp.MustCompile(`^new\s+Date\(\)\.(getFullYear|getMonth|getDate|getDay|getHours|getMinutes|getSeconds)\(\)$`)
	reDateMethodPlus  = regexp.MustCompile(`^new\s+Date\(\)\.(getMonth|getDate)\(\)\s*\+\s*1$`)
	reDateString      = regexp.MustCompile(`^new\s+Date\(\)\.(toISOString|toDateString|toLocaleDateString|toLocaleTimeString|toLocaleString)\(\s*\)$`)
	reDateStringArg   = regexp.MustCompile(`^new\s+Date\(\)\.(toLocaleDateString|toLocaleTimeString|toLocaleString)\(\s*['"]([a-zA-Z-]+)['"]\s*\)$`)
	reNumberToFixed   = regexp.MustCompile(`^(.+)\.toFixed\(\s*(\d+)\s*\)$`)
	reSimpleArith     = regexp.MustCompile(`^(-?[\d.]+)\s*([+\-*/])\s*(-?[\d.]+)$`)
)

// reFrontMatter matches a YAML front-matter block at the top of the
// source. Used to expose meta-data values (`title`, `author`,
// `date`, …) as template bindings so `${author}` in the body
// resolves to the YAML value.
var reFrontMatter = regexp.MustCompile(`(?s)\A---\s*\n(.*?)\n---\s*\n?`)
var reYAMLLine = regexp.MustCompile(`^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*?)\s*$`)

// parseFrontMatterBindings : extracts simple `key: value` pairs from
// the YAML front-matter for use as template variables. Mirrors the
// browser-side parseFrontMatterBindings in templateExpr.ts.
func parseFrontMatterBindings(src string) map[string]string {
	out := map[string]string{}
	m := reFrontMatter.FindStringSubmatch(src)
	if m == nil {
		return out
	}
	for _, line := range strings.Split(m[1], "\n") {
		kv := reYAMLLine.FindStringSubmatch(line)
		if kv == nil {
			continue
		}
		v := kv[2]
		if len(v) >= 2 {
			if (v[0] == '"' && v[len(v)-1] == '"') || (v[0] == '\'' && v[len(v)-1] == '\'') {
				v = v[1 : len(v)-1]
			}
		}
		out[kv[1]] = v
		if strings.Contains(kv[1], "-") {
			out[strings.ReplaceAll(kv[1], "-", "_")] = v
		}
	}
	return out
}

// ExpandTemplate is the exported entry point. now is injected so
// tests can pin a deterministic timestamp.
func ExpandTemplate(src string, now time.Time) string {
	if !strings.Contains(src, "${") {
		return src
	}
	// First, mark escapes : `$${x}` → \x00ESC{x}\x00
	src = reEscape.ReplaceAllString(src, "\x00ESC{$1}\x00")
	// Resolve front-matter bindings once ; cheap regex pass.
	bindings := parseFrontMatterBindings(src)
	// Then evaluate active placeholders.
	src = rePlaceholder.ReplaceAllStringFunc(src, func(match string) string {
		body := strings.TrimSpace(match[2 : len(match)-1])
		// Front-matter variable reference takes priority over the
		// Math / Date whitelist : `${title}` shouldn't be misread as
		// an arithmetic expression.
		if v, ok := bindings[body]; ok {
			return v
		}
		if v, ok := evalExpression(body, now); ok {
			return v
		}
		return match
	})
	// Finally, restore escapes.
	src = strings.ReplaceAll(src, "\x00ESC{", "${")
	src = strings.ReplaceAll(src, "}\x00", "}")
	return src
}

// evalExpression returns (value, true) if the body matched one of
// the whitelisted patterns. Otherwise (_, false) — caller keeps the
// raw `${...}` text so the author can fix the typo.
func evalExpression(body string, now time.Time) (string, bool) {
	// .toFixed(n) wrapper — strip and recurse on the inner numeric.
	if m := reNumberToFixed.FindStringSubmatch(body); m != nil {
		inner, ok := evalExpression(strings.TrimSpace(m[1]), now)
		if !ok {
			return "", false
		}
		f, err := strconv.ParseFloat(inner, 64)
		if err != nil {
			return "", false
		}
		digits, _ := strconv.Atoi(m[2])
		return strconv.FormatFloat(f, 'f', digits, 64), true
	}
	// Math constants.
	if m := reMathConst.FindStringSubmatch(body); m != nil {
		switch m[1] {
		case "PI":
			return formatFloat(math.Pi), true
		case "E":
			return formatFloat(math.E), true
		case "LN2":
			return formatFloat(math.Ln2), true
		case "LN10":
			return formatFloat(math.Log(10)), true
		case "LOG2E":
			return formatFloat(math.Log2E), true
		case "LOG10E":
			return formatFloat(math.Log10E), true
		case "SQRT2":
			return formatFloat(math.Sqrt2), true
		}
	}
	if m := reMathFunc.FindStringSubmatch(body); m != nil {
		v, err := strconv.ParseFloat(m[2], 64)
		if err != nil {
			return "", false
		}
		switch m[1] {
		case "round":
			return strconv.FormatFloat(math.Round(v), 'f', -1, 64), true
		case "floor":
			return strconv.FormatFloat(math.Floor(v), 'f', -1, 64), true
		case "ceil":
			return strconv.FormatFloat(math.Ceil(v), 'f', -1, 64), true
		case "abs":
			return strconv.FormatFloat(math.Abs(v), 'f', -1, 64), true
		case "sqrt":
			return formatFloat(math.Sqrt(v)), true
		case "log":
			return formatFloat(math.Log(v)), true
		case "exp":
			return formatFloat(math.Exp(v)), true
		case "sin":
			return formatFloat(math.Sin(v)), true
		case "cos":
			return formatFloat(math.Cos(v)), true
		case "tan":
			return formatFloat(math.Tan(v)), true
		}
	}
	if m := reMathPow.FindStringSubmatch(body); m != nil {
		x, _ := strconv.ParseFloat(m[1], 64)
		y, _ := strconv.ParseFloat(m[2], 64)
		return formatFloat(math.Pow(x, y)), true
	}
	// Date methods returning numbers — the +1 variant first so the
	// 1-indexed month / day idioms (`getMonth() + 1`) get the right
	// answer instead of falling through to literal addition.
	if m := reDateMethodPlus.FindStringSubmatch(body); m != nil {
		switch m[1] {
		case "getMonth":
			return strconv.Itoa(int(now.Month())), true
		case "getDate":
			return strconv.Itoa(now.Day() + 1), true
		}
	}
	if m := reDateMethod.FindStringSubmatch(body); m != nil {
		switch m[1] {
		case "getFullYear":
			return strconv.Itoa(now.Year()), true
		case "getMonth":
			return strconv.Itoa(int(now.Month()) - 1), true
		case "getDate":
			return strconv.Itoa(now.Day()), true
		case "getDay":
			return strconv.Itoa(int(now.Weekday())), true
		case "getHours":
			return strconv.Itoa(now.Hour()), true
		case "getMinutes":
			return strconv.Itoa(now.Minute()), true
		case "getSeconds":
			return strconv.Itoa(now.Second()), true
		}
	}
	if m := reDateString.FindStringSubmatch(body); m != nil {
		switch m[1] {
		case "toISOString":
			return now.UTC().Format("2006-01-02T15:04:05.000Z"), true
		case "toDateString":
			return now.Format("Mon Jan 02 2006"), true
		case "toLocaleDateString":
			return now.Format("01/02/2006"), true
		case "toLocaleTimeString":
			return now.Format("15:04:05"), true
		case "toLocaleString":
			return now.Format("01/02/2006, 15:04:05"), true
		}
	}
	if m := reDateStringArg.FindStringSubmatch(body); m != nil {
		// Locale-aware variants. We support a handful of common locales
		// explicitly ; everything else falls back to the same format as
		// the default.
		locale := strings.ToLower(m[2])
		switch m[1] {
		case "toLocaleDateString":
			switch locale {
			case "fr-fr", "fr":
				return now.Format("02/01/2006"), true
			case "de-de", "de":
				return now.Format("2.1.2006"), true
			case "ja-jp", "ja":
				return now.Format("2006/1/2"), true
			case "en-gb", "en":
				return now.Format("02/01/2006"), true
			default:
				return now.Format("01/02/2006"), true
			}
		case "toLocaleTimeString":
			return now.Format("15:04:05"), true
		case "toLocaleString":
			return now.Format("02/01/2006, 15:04:05"), true
		}
	}
	// Simple two-operand arithmetic on literals — handles cases like
	// `${ 2026 - 1959 }` for "67 years since" without dragging in a
	// real expression parser.
	if m := reSimpleArith.FindStringSubmatch(body); m != nil {
		a, _ := strconv.ParseFloat(m[1], 64)
		b, _ := strconv.ParseFloat(m[3], 64)
		var r float64
		switch m[2] {
		case "+":
			r = a + b
		case "-":
			r = a - b
		case "*":
			r = a * b
		case "/":
			if b == 0 {
				return "", false
			}
			r = a / b
		}
		return formatFloat(r), true
	}
	// Plain integer / float literal.
	if _, err := strconv.ParseFloat(body, 64); err == nil {
		return body, true
	}
	return "", false
}

// formatFloat trims trailing zeros so `Math.PI` prints `3.141592653589793`
// instead of `3.14159265358979300000`, matching JS Number.toString().
func formatFloat(f float64) string {
	s := strconv.FormatFloat(f, 'g', -1, 64)
	if s == "+Inf" || s == "-Inf" || s == "NaN" {
		return s
	}
	return s
}

var _ = fmt.Sprintf // reserved for future debug log on rejected expressions
