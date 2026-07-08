import { ParseSourceSpan } from "../parse_util.mjs";
import { I18nMeta } from "../i18n/i18n_ast.mjs";
import { InterpolatedAttributeToken, InterpolatedTextToken } from "./tokens.mjs";

//#region ../compiler/src/ml_parser/ast.d.ts
/**
* @license
* Copyright Google LLC All Rights Reserved.
*
* Use of this source code is governed by an MIT-style license that can be
* found in the LICENSE file at https://angular.dev/license
*/
declare namespace ast_d_exports {
  export { Attribute, Block, BlockParameter, CDATA, Comment, Component, Directive, DocType, Element, Expansion, ExpansionCase, LetDeclaration, Node, NodeWithI18n, RecursiveVisitor, Text, Visitor, visitAll };
}
interface BaseNode {
  sourceSpan: ParseSourceSpan;
  visit(visitor: Visitor, context: any): any;
}
type Node = Attribute | CDATA | Comment | DocType | Element | Expansion | ExpansionCase | Text | Block | BlockParameter | LetDeclaration | Component | Directive;
declare abstract class NodeWithI18n implements BaseNode {
  sourceSpan: ParseSourceSpan;
  i18n?: I18nMeta;
  constructor(sourceSpan: ParseSourceSpan, i18n?: I18nMeta);
  abstract visit(visitor: Visitor, context: any): any;
}
declare class Text extends NodeWithI18n {
  value: string;
  tokens: InterpolatedTextToken[];
  constructor(value: string, sourceSpan: ParseSourceSpan, tokens: InterpolatedTextToken[], i18n?: I18nMeta);
  visit(visitor: Visitor, context: any): any;
  readonly kind = "text";
}
declare class CDATA extends NodeWithI18n {
  value: string;
  tokens: InterpolatedTextToken[];
  constructor(value: string, sourceSpan: ParseSourceSpan, tokens: InterpolatedTextToken[], i18n?: I18nMeta);
  visit(visitor: Visitor, context: any): any;
  readonly kind = "cdata";
}
declare class Expansion extends NodeWithI18n {
  switchValue: string;
  type: string;
  cases: ExpansionCase[];
  switchValueSourceSpan: ParseSourceSpan;
  constructor(switchValue: string, type: string, cases: ExpansionCase[], sourceSpan: ParseSourceSpan, switchValueSourceSpan: ParseSourceSpan, i18n?: I18nMeta);
  visit(visitor: Visitor, context: any): any;
  readonly kind = "expansion";
}
declare class ExpansionCase implements BaseNode {
  value: string;
  expression: Node[];
  sourceSpan: ParseSourceSpan;
  valueSourceSpan: ParseSourceSpan;
  expSourceSpan: ParseSourceSpan;
  constructor(value: string, expression: Node[], sourceSpan: ParseSourceSpan, valueSourceSpan: ParseSourceSpan, expSourceSpan: ParseSourceSpan);
  visit(visitor: Visitor, context: any): any;
  readonly kind = "expansionCase";
}
declare class Attribute extends NodeWithI18n {
  name: string;
  value: string;
  readonly keySpan: ParseSourceSpan | undefined;
  valueSpan: ParseSourceSpan | undefined;
  valueTokens: InterpolatedAttributeToken[] | undefined;
  constructor(name: string, value: string, sourceSpan: ParseSourceSpan, keySpan: ParseSourceSpan | undefined, valueSpan: ParseSourceSpan | undefined, valueTokens: InterpolatedAttributeToken[] | undefined, i18n: I18nMeta | undefined);
  visit(visitor: Visitor, context: any): any;
  readonly kind = "attribute";
  get nameSpan(): ParseSourceSpan;
}
declare class Element extends NodeWithI18n {
  name: string;
  attrs: Attribute[];
  readonly directives: Directive[];
  children: Node[];
  readonly isSelfClosing: boolean;
  startSourceSpan: ParseSourceSpan;
  endSourceSpan: ParseSourceSpan | null;
  nameSpan: ParseSourceSpan | null;
  readonly isVoid: boolean;
  constructor(name: string, attrs: Attribute[], directives: Directive[], children: Node[], isSelfClosing: boolean, sourceSpan: ParseSourceSpan, startSourceSpan: ParseSourceSpan, endSourceSpan: ParseSourceSpan | null, nameSpan: ParseSourceSpan | null, isVoid: boolean, i18n?: I18nMeta);
  visit(visitor: Visitor, context: any): any;
  readonly kind = "element";
}
declare class Comment implements BaseNode {
  value: string | null;
  sourceSpan: ParseSourceSpan;
  constructor(value: string | null, sourceSpan: ParseSourceSpan);
  visit(visitor: Visitor, context: any): any;
  readonly kind = "comment";
}
declare class DocType implements BaseNode {
  value: string | null;
  sourceSpan: ParseSourceSpan;
  constructor(value: string | null, sourceSpan: ParseSourceSpan);
  visit(visitor: Visitor, context: any): any;
  readonly kind = "docType";
}
declare class Block extends NodeWithI18n {
  name: string;
  parameters: BlockParameter[];
  children: Node[];
  nameSpan: ParseSourceSpan;
  startSourceSpan: ParseSourceSpan;
  endSourceSpan: ParseSourceSpan | null;
  constructor(name: string, parameters: BlockParameter[], children: Node[], sourceSpan: ParseSourceSpan, nameSpan: ParseSourceSpan, startSourceSpan: ParseSourceSpan, endSourceSpan?: ParseSourceSpan | null, i18n?: I18nMeta);
  visit(visitor: Visitor, context: any): any;
  readonly kind = "block";
}
declare class Component extends NodeWithI18n {
  readonly componentName: string;
  readonly tagName: string | null;
  readonly fullName: string;
  attrs: Attribute[];
  readonly directives: Directive[];
  readonly children: Node[];
  readonly isSelfClosing: boolean;
  readonly startSourceSpan: ParseSourceSpan;
  endSourceSpan: ParseSourceSpan | null;
  constructor(componentName: string, tagName: string | null, fullName: string, attrs: Attribute[], directives: Directive[], children: Node[], isSelfClosing: boolean, sourceSpan: ParseSourceSpan, startSourceSpan: ParseSourceSpan, endSourceSpan?: ParseSourceSpan | null, i18n?: I18nMeta);
  visit(visitor: Visitor, context: any): any;
  readonly kind = "component";
}
declare class Directive implements BaseNode {
  readonly name: string;
  readonly attrs: Attribute[];
  readonly sourceSpan: ParseSourceSpan;
  readonly startSourceSpan: ParseSourceSpan;
  readonly endSourceSpan: ParseSourceSpan | null;
  constructor(name: string, attrs: Attribute[], sourceSpan: ParseSourceSpan, startSourceSpan: ParseSourceSpan, endSourceSpan?: ParseSourceSpan | null);
  visit(visitor: Visitor, context: any): any;
  readonly kind = "directive";
}
declare class BlockParameter implements BaseNode {
  expression: string;
  sourceSpan: ParseSourceSpan;
  constructor(expression: string, sourceSpan: ParseSourceSpan);
  visit(visitor: Visitor, context: any): any;
  readonly kind = "blockParameter";
  readonly startSourceSpan: null;
  readonly endSourceSpan: null;
}
declare class LetDeclaration implements BaseNode {
  name: string;
  value: string;
  sourceSpan: ParseSourceSpan;
  readonly nameSpan: ParseSourceSpan;
  valueSpan: ParseSourceSpan;
  constructor(name: string, value: string, sourceSpan: ParseSourceSpan, nameSpan: ParseSourceSpan, valueSpan: ParseSourceSpan);
  visit(visitor: Visitor, context: any): any;
  readonly kind = "letDeclaration";
  readonly startSourceSpan: null;
  readonly endSourceSpan: null;
}
interface Visitor {
  visit?(node: Node, context: any): any;
  visitElement(element: Element, context: any): any;
  visitAttribute(attribute: Attribute, context: any): any;
  visitText(text: Text, context: any): any;
  visitCdata(text: CDATA, context: any): any;
  visitComment(comment: Comment, context: any): any;
  visitDocType(docType: DocType, context: any): any;
  visitExpansion(expansion: Expansion, context: any): any;
  visitExpansionCase(expansionCase: ExpansionCase, context: any): any;
  visitBlock(block: Block, context: any): any;
  visitBlockParameter(parameter: BlockParameter, context: any): any;
  visitLetDeclaration(decl: LetDeclaration, context: any): any;
  visitComponent(component: Component, context: any): any;
  visitDirective(directive: Directive, context: any): any;
}
declare function visitAll(visitor: Visitor, nodes: Node[], context?: any): any[];
declare class RecursiveVisitor implements Visitor {
  constructor();
  visitElement(ast: Element, context: any): any;
  visitAttribute(ast: Attribute, context: any): any;
  visitText(ast: Text, context: any): any;
  visitCdata(ast: CDATA, context: any): any;
  visitComment(ast: Comment, context: any): any;
  visitDocType(ast: DocType, context: any): any;
  visitExpansion(ast: Expansion, context: any): any;
  visitExpansionCase(ast: ExpansionCase, context: any): any;
  visitBlock(block: Block, context: any): any;
  visitBlockParameter(ast: BlockParameter, context: any): any;
  visitLetDeclaration(decl: LetDeclaration, context: any): void;
  visitComponent(component: Component, context: any): void;
  visitDirective(directive: Directive, context: any): void;
  private visitChildren;
}
//#endregion
export { Node, RecursiveVisitor, ast_d_exports, visitAll };