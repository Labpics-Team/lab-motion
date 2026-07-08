import { ParseSourceSpan } from "../parse_util.mjs";

//#region ../compiler/src/ml_parser/tokens.d.ts
/**
* @license
* Copyright Google LLC All Rights Reserved.
*
* Use of this source code is governed by an MIT-style license that can be
* found in the LICENSE file at https://angular.dev/license
*/
declare const enum TokenType {
  TAG_OPEN_START = 0,
  TAG_OPEN_END = 1,
  TAG_OPEN_END_VOID = 2,
  TAG_CLOSE = 3,
  INCOMPLETE_TAG_OPEN = 4,
  TEXT = 5,
  ESCAPABLE_RAW_TEXT = 6,
  RAW_TEXT = 7,
  INTERPOLATION = 8,
  ENCODED_ENTITY = 9,
  COMMENT_START = 10,
  COMMENT_END = 11,
  CDATA_START = 12,
  CDATA_END = 13,
  ATTR_NAME = 14,
  ATTR_QUOTE = 15,
  ATTR_VALUE_TEXT = 16,
  ATTR_VALUE_INTERPOLATION = 17,
  DOC_TYPE_START = 18,
  DOC_TYPE_END = 19,
  EXPANSION_FORM_START = 20,
  EXPANSION_CASE_VALUE = 21,
  EXPANSION_CASE_EXP_START = 22,
  EXPANSION_CASE_EXP_END = 23,
  EXPANSION_FORM_END = 24,
  BLOCK_OPEN_START = 25,
  BLOCK_OPEN_END = 26,
  BLOCK_CLOSE = 27,
  BLOCK_PARAMETER = 28,
  INCOMPLETE_BLOCK_OPEN = 29,
  LET_START = 30,
  LET_VALUE = 31,
  LET_END = 32,
  INCOMPLETE_LET = 33,
  COMPONENT_OPEN_START = 34,
  COMPONENT_OPEN_END = 35,
  COMPONENT_OPEN_END_VOID = 36,
  COMPONENT_CLOSE = 37,
  INCOMPLETE_COMPONENT_OPEN = 38,
  DIRECTIVE_NAME = 39,
  DIRECTIVE_OPEN = 40,
  DIRECTIVE_CLOSE = 41,
  EOF = 42,
}
type InterpolatedTextToken = TextToken | InterpolationToken | EncodedEntityToken;
type InterpolatedAttributeToken = AttributeValueTextToken | AttributeValueInterpolationToken | EncodedEntityToken;
interface TokenBase {
  type: TokenType;
  parts: string[];
  sourceSpan: ParseSourceSpan;
}
interface TextToken extends TokenBase {
  type: TokenType.TEXT | TokenType.ESCAPABLE_RAW_TEXT | TokenType.RAW_TEXT;
  parts: [text: string];
}
interface InterpolationToken extends TokenBase {
  type: TokenType.INTERPOLATION;
  parts: [startMarker: string, expression: string, endMarker: string] | [startMarker: string, expression: string];
}
interface EncodedEntityToken extends TokenBase {
  type: TokenType.ENCODED_ENTITY;
  parts: [decoded: string, encoded: string];
}
interface AttributeValueTextToken extends TokenBase {
  type: TokenType.ATTR_VALUE_TEXT;
  parts: [value: string];
}
interface AttributeValueInterpolationToken extends TokenBase {
  type: TokenType.ATTR_VALUE_INTERPOLATION;
  parts: [startMarker: string, expression: string, endMarker: string] | [startMarker: string, expression: string];
}
//#endregion
export { InterpolatedAttributeToken, InterpolatedTextToken };