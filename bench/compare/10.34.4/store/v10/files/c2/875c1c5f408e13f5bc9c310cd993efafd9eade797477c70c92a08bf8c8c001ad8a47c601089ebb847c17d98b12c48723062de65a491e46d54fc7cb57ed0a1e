//#region ../compiler/src/chars.ts
/**
* @license
* Copyright Google LLC All Rights Reserved.
*
* Use of this source code is governed by an MIT-style license that can be
* found in the LICENSE file at https://angular.dev/license
*/
const $EOF = 0;
const $BSPACE = 8;
const $TAB = 9;
const $LF = 10;
const $VTAB = 11;
const $FF = 12;
const $CR = 13;
const $SPACE = 32;
const $BANG = 33;
const $DQ = 34;
const $HASH = 35;
const $$ = 36;
const $AMPERSAND = 38;
const $SQ = 39;
const $LPAREN = 40;
const $RPAREN = 41;
const $COMMA = 44;
const $SLASH = 47;
const $COLON = 58;
const $SEMICOLON = 59;
const $LT = 60;
const $EQ = 61;
const $GT = 62;
const $QUESTION = 63;
const $0 = 48;
const $7 = 55;
const $9 = 57;
const $A = 65;
const $F = 70;
const $X = 88;
const $Z = 90;
const $LBRACKET = 91;
const $BACKSLASH = 92;
const $RBRACKET = 93;
const $_ = 95;
const $a = 97;
const $b = 98;
const $f = 102;
const $n = 110;
const $r = 114;
const $t = 116;
const $u = 117;
const $v = 118;
const $x = 120;
const $z = 122;
const $LBRACE = 123;
const $RBRACE = 125;
const $NBSP = 160;
const $AT = 64;
const $BT = 96;
function isWhitespace(code) {
	return code >= $TAB && code <= $SPACE || code == $NBSP;
}
function isDigit(code) {
	return $0 <= code && code <= $9;
}
function isAsciiLetter(code) {
	return code >= $a && code <= $z || code >= $A && code <= $Z;
}
function isAsciiHexDigit(code) {
	return code >= $a && code <= $f || code >= $A && code <= $F || isDigit(code);
}
function isNewLine(code) {
	return code === $LF || code === $CR;
}
function isOctalDigit(code) {
	return $0 <= code && code <= $7;
}
function isQuote(code) {
	return code === $SQ || code === $DQ || code === $BT;
}

//#endregion
export { $$, $0, $9, $A, $AMPERSAND, $AT, $BACKSLASH, $BANG, $BSPACE, $COLON, $COMMA, $CR, $DQ, $EOF, $EQ, $FF, $GT, $HASH, $LBRACE, $LBRACKET, $LF, $LPAREN, $LT, $QUESTION, $RBRACE, $RBRACKET, $RPAREN, $SEMICOLON, $SLASH, $SQ, $TAB, $VTAB, $X, $Z, $_, $a, $b, $f, $n, $r, $t, $u, $v, $x, $z, isAsciiHexDigit, isAsciiLetter, isDigit, isNewLine, isOctalDigit, isQuote, isWhitespace };