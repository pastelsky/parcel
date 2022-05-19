use std::cmp::Ordering;
use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use swc_atoms::JsWord;
use swc_common::{Mark, Span, SyntaxContext, DUMMY_SP};
use swc_ecmascript::ast;

pub fn match_member_expr(
  expr: &ast::MemberExpr,
  idents: Vec<&str>,
  decls: &HashSet<(JsWord, SyntaxContext)>,
) -> bool {
  use ast::{Expr, Ident, Lit, MemberProp, Str};

  let mut member = expr;
  let mut idents = idents;
  while idents.len() > 1 {
    let expected = idents.pop().unwrap();
    let prop = match &member.prop {
      MemberProp::Computed(comp) => {
        if let Expr::Lit(Lit::Str(Str { value: ref sym, .. })) = *comp.expr {
          sym
        } else {
          return false;
        }
      }
      MemberProp::Ident(Ident { ref sym, .. }) => sym,
      _ => return false,
    };

    if prop != expected {
      return false;
    }

    match &*member.obj {
      Expr::Member(m) => member = m,
      Expr::Ident(Ident { ref sym, span, .. }) => {
        return idents.len() == 1
          && sym == idents.pop().unwrap()
          && !decls.contains(&(sym.clone(), span.ctxt()));
      }
      _ => return false,
    }
  }

  false
}

pub fn create_require(specifier: swc_atoms::JsWord) -> ast::CallExpr {
  let mut normalized_specifier = specifier;
  if normalized_specifier.starts_with("node:") {
    normalized_specifier = normalized_specifier.replace("node:", "").into();
  }

  ast::CallExpr {
    callee: ast::Callee::Expr(Box::new(ast::Expr::Ident(ast::Ident::new(
      "require".into(),
      DUMMY_SP,
    )))),
    args: vec![ast::ExprOrSpread {
      expr: Box::new(ast::Expr::Lit(ast::Lit::Str(normalized_specifier.into()))),
      spread: None,
    }],
    span: DUMMY_SP,
    type_args: None,
  }
}

fn is_marked(span: Span, mark: Mark) -> bool {
  let mut ctxt = span.ctxt();

  loop {
    let m = ctxt.remove_mark();
    if m == Mark::root() {
      return false;
    }

    if m == mark {
      return true;
    }
  }
}

pub fn match_str(node: &ast::Expr) -> Option<(JsWord, Span)> {
  use ast::*;

  match node {
    // "string" or 'string'
    Expr::Lit(Lit::Str(s)) => Some((s.value.clone(), s.span)),
    // `string`
    Expr::Tpl(tpl) if tpl.quasis.len() == 1 && tpl.exprs.is_empty() => {
      Some((tpl.quasis[0].raw.clone(), tpl.span))
    }
    _ => None,
  }
}

pub fn match_property_name(node: &ast::MemberExpr) -> Option<(JsWord, Span)> {
  match &node.prop {
    ast::MemberProp::Computed(s) => match_str(&*s.expr),
    ast::MemberProp::Ident(id) => Some((id.sym.clone(), id.span)),
    ast::MemberProp::PrivateName(_) => None,
  }
}

pub fn match_export_name(name: &ast::ModuleExportName) -> (JsWord, Span) {
  match name {
    ast::ModuleExportName::Ident(id) => (id.sym.clone(), id.span),
    ast::ModuleExportName::Str(s) => (s.value.clone(), s.span),
  }
}

/// Properties like `ExportNamedSpecifier::orig` have to be an Ident if `src` is `None`
pub fn match_export_name_ident(name: &ast::ModuleExportName) -> &ast::Ident {
  match name {
    ast::ModuleExportName::Ident(id) => id,
    ast::ModuleExportName::Str(_) => unreachable!(),
  }
}

pub fn match_require(
  node: &ast::Expr,
  decls: &HashSet<(JsWord, SyntaxContext)>,
  ignore_mark: Mark,
) -> Option<JsWord> {
  use ast::*;

  match node {
    Expr::Call(call) => match &call.callee {
      Callee::Expr(expr) => match &**expr {
        Expr::Ident(ident) => {
          if ident.sym == js_word!("require")
            && !decls.contains(&(ident.sym.clone(), ident.span.ctxt))
            && !is_marked(ident.span, ignore_mark)
          {
            if let Some(arg) = call.args.get(0) {
              return match_str(&*arg.expr).map(|(name, _)| name);
            }
          }

          None
        }
        Expr::Member(member) => {
          if match_member_expr(member, vec!["module", "require"], decls) {
            if let Some(arg) = call.args.get(0) {
              return match_str(&*arg.expr).map(|(name, _)| name);
            }
          }

          None
        }
        _ => None,
      },
      _ => None,
    },
    _ => None,
  }
}

pub fn match_import(node: &ast::Expr, ignore_mark: Mark) -> Option<JsWord> {
  use ast::*;

  match node {
    Expr::Call(call) => match &call.callee {
      Callee::Import(ident) if !is_marked(ident.span, ignore_mark) => {
        if let Some(arg) = call.args.get(0) {
          return match_str(&*arg.expr).map(|(name, _)| name);
        }
        None
      }
      _ => None,
    },
    _ => None,
  }
}

// `name` must not be an existing binding.
pub fn create_global_decl_stmt(
  name: swc_atoms::JsWord,
  init: ast::Expr,
  global_mark: Mark,
) -> (ast::Stmt, SyntaxContext) {
  // The correct value would actually be `DUMMY_SP.apply_mark(Mark::fresh(Mark::root()))`.
  // But this saves us from running the resolver again in some cases.
  let span = DUMMY_SP.apply_mark(global_mark);

  (
    ast::Stmt::Decl(ast::Decl::Var(ast::VarDecl {
      kind: ast::VarDeclKind::Var,
      declare: false,
      span: DUMMY_SP,
      decls: vec![ast::VarDeclarator {
        name: ast::Pat::Ident(ast::BindingIdent::from(ast::Ident::new(name, span))),
        span: DUMMY_SP,
        definite: false,
        init: Some(Box::new(init)),
      }],
    })),
    span.ctxt,
  )
}

#[derive(Debug, Serialize, Deserialize, Clone, Eq, PartialEq)]
pub struct SourceLocation {
  pub start_line: usize,
  pub start_col: usize,
  pub end_line: usize,
  pub end_col: usize,
}

impl SourceLocation {
  pub fn from(source_map: &swc_common::SourceMap, span: swc_common::Span) -> Self {
    if span.lo.is_dummy() || span.hi.is_dummy() {
      return SourceLocation {
        start_line: 1,
        start_col: 1,
        end_line: 1,
        end_col: 1,
      };
    }

    let start = source_map.lookup_char_pos(span.lo);
    let end = source_map.lookup_char_pos(span.hi);
    // - SWC's columns are exclusive, ours are inclusive (column - 1)
    // - SWC has 0-based columns, ours are 1-based (column + 1)
    // = +-0
    SourceLocation {
      start_line: start.line,
      start_col: start.col_display + 1,
      end_line: end.line,
      end_col: end.col_display,
    }
  }
}

impl PartialOrd for SourceLocation {
  fn partial_cmp(&self, other: &SourceLocation) -> Option<Ordering> {
    match self.start_line.cmp(&other.start_line) {
      Ordering::Equal => self.start_col.partial_cmp(&other.start_col),
      o => Some(o),
    }
  }
}

#[derive(Serialize, Deserialize, Debug)]
pub struct CodeHighlight {
  pub message: Option<String>,
  pub loc: SourceLocation,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct Diagnostic {
  pub message: String,
  pub code_highlights: Option<Vec<CodeHighlight>>,
  pub hints: Option<Vec<String>>,
  pub show_environment: bool,
  pub severity: DiagnosticSeverity,
  pub documentation_url: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Eq, PartialEq)]
pub enum DiagnosticSeverity {
  /// Fails the build with an error.
  Error,
  /// Logs a warning, but the build does not fail.
  Warning,
  /// An error if this is source code in the project, or a warning if in node_modules.
  SourceError,
}

#[derive(Serialize, Debug, Deserialize, Eq, PartialEq, Clone, Copy)]
pub enum SourceType {
  Script,
  Module,
}

pub struct Bailout {
  pub loc: SourceLocation,
  pub reason: BailoutReason,
}

impl Bailout {
  pub fn to_diagnostic(&self) -> Diagnostic {
    let (message, documentation_url) = self.reason.info();
    Diagnostic {
      message: message.into(),
      documentation_url: Some(documentation_url.into()),
      code_highlights: Some(vec![CodeHighlight {
        loc: self.loc.clone(),
        message: None,
      }]),
      show_environment: false,
      severity: DiagnosticSeverity::Warning,
      hints: None,
    }
  }
}

pub enum BailoutReason {
  NonTopLevelRequire,
  NonStaticDestructuring,
  TopLevelReturn,
  Eval,
  NonStaticExports,
  FreeModule,
  FreeExports,
  ExportsReassignment,
  ModuleReassignment,
  NonStaticDynamicImport,
  NonStaticAccess,
}

impl BailoutReason {
  fn info(&self) -> (&str, &str) {
    match self {
      BailoutReason::NonTopLevelRequire => (
        "Conditional or non-top-level `require()` call. This causes the resolved module and all dependendencies to be wrapped.",
        "https://parceljs.org/features/scope-hoisting/#avoid-conditional-require()"
      ),
      BailoutReason::NonStaticDestructuring => (
        "Non-static destructuring of `require` or dynamic `import()`. This causes all exports of the resolved module to be included.",
        "https://parceljs.org/features/scope-hoisting/#commonjs"
      ),
      BailoutReason::TopLevelReturn => (
        "Module contains a top-level `return` statement. This causes the module to be wrapped in a function and tree shaking to be disabled.",
        "https://parceljs.org/features/scope-hoisting/#avoid-top-level-return"
      ),
      BailoutReason::Eval => (
        "Module contains usage of `eval`. This causes the module to be wrapped in a function and minification to be disabled.",
        "https://parceljs.org/features/scope-hoisting/#avoid-eval"
      ),
      BailoutReason::NonStaticExports => (
        "Non-static access of CommonJS `exports` object. This causes tree shaking to be disabled for the module.",
        "https://parceljs.org/features/scope-hoisting/#commonjs"
      ),
      BailoutReason::FreeModule => (
        "Unknown usage of CommonJS `module` object. This causes the module to be wrapped, and tree shaking to be disabled.",
        "https://parceljs.org/features/scope-hoisting/#commonjs"
      ),
      BailoutReason::FreeExports => (
        "Unknown usage of CommonJS `exports` object. This causes tree shaking to be disabled.",
        "https://parceljs.org/features/scope-hoisting/#commonjs"
      ),
      BailoutReason::ExportsReassignment => (
        "Module contains a reassignment of the CommonJS `exports` object. This causes the module to be wrapped and tree-shaking to be disabled.",
        "https://parceljs.org/features/scope-hoisting/#avoid-module-and-exports-re-assignment"
      ),
      BailoutReason::ModuleReassignment => (
        "Module contains a reassignment of the CommonJS `module` object. This causes the module to be wrapped and tree-shaking to be disabled.",
        "https://parceljs.org/features/scope-hoisting/#avoid-module-and-exports-re-assignment"
      ),
      BailoutReason::NonStaticDynamicImport => (
        "Unknown dynamic import usage. This causes tree shaking to be disabled for the resolved module.",
        "https://parceljs.org/features/scope-hoisting/#dynamic-imports"
      ),
      BailoutReason::NonStaticAccess => (
        "Non-static access of an `import` or `require`. This causes tree shaking to be disabled for the resolved module.",
        "https://parceljs.org/features/scope-hoisting/#dynamic-member-accesses"
      ),
    }
  }
}

#[macro_export]
macro_rules! fold_member_expr_skip_prop {
  () => {
    fn fold_member_expr(
      &mut self,
      mut node: swc_ecmascript::ast::MemberExpr,
    ) -> swc_ecmascript::ast::MemberExpr {
      node.obj = node.obj.fold_with(self);

      if let swc_ecmascript::ast::MemberProp::Computed(_) = node.prop {
        node.prop = node.prop.fold_with(self);
      }

      node
    }
  };
}

#[macro_export]
macro_rules! id {
  ($ident: expr) => {
    ($ident.sym.clone(), $ident.span.ctxt)
  };
}

pub type IdentId = (JsWord, SyntaxContext);
