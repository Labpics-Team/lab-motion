import { TagContentType } from "./compiler/src/ml_parser/tags.mjs";
import { ParseLocation, ParseSourceFile, ParseSourceSpan } from "./compiler/src/parse_util.mjs";
import { RecursiveVisitor, ast_d_exports, visitAll } from "./compiler/src/ml_parser/ast.mjs";
import { ParseTreeResult } from "./compiler/src/ml_parser/parser.mjs";
import { getHtmlTagDefinition } from "./compiler/src/ml_parser/html_tags.mjs";

//#region src/index.d.ts
interface HtmlParseOptions {
  /**
       * any element can self close
       *
       * defaults to false
       */
  canSelfClose?: boolean;
  /**
       * support [`htm`](https://github.com/developit/htm) component closing tags (`<//>`)
       *
       * defaults to false
       */
  allowHtmComponentClosingTags?: boolean;
  /**
       * do not lowercase tag names before querying their tag definitions
       *
       * defaults to false
       */
  isTagNameCaseSensitive?: boolean;
  /**
       * customize tag content type
       *
       * defaults to the content type defined in the HTML spec
       */
  getTagContentType?: (tagName: string, prefix: string, hasParent: boolean, attrs: Array<{
    prefix: string;
    name: string;
    value?: string;
  }>) => void | TagContentType;
  /**
       * tokenize angular control flow block syntax
       */
  tokenizeAngularBlocks?: boolean;
  /**
       * tokenize angular let declaration syntax
       */
  tokenizeAngularLetDeclaration?: boolean;
  /**
       * enable angular selectorless syntax
       */
  enableAngularSelectorlessSyntax?: boolean;
}
declare function parseHtml(input: string, options?: HtmlParseOptions): ParseTreeResult;
declare function parseXml(input: string): ParseTreeResult;
//#endregion
export { type ast_d_exports as Ast, HtmlParseOptions, type HtmlParseOptions as ParseOptions, ParseLocation, ParseSourceFile, ParseSourceSpan, type ParseTreeResult, RecursiveVisitor, TagContentType, getHtmlTagDefinition, parseHtml as parse, parseHtml, parseXml, visitAll };