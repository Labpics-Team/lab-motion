import { TagContentType, mergeNsAndName } from "./tags.mjs";
import { $$, $0, $9, $A, $AMPERSAND, $AT, $BACKSLASH, $BANG, $BSPACE, $COLON, $COMMA, $CR, $DQ, $EOF, $EQ, $FF, $GT, $HASH, $LBRACE, $LBRACKET, $LF, $LPAREN, $LT, $QUESTION, $RBRACE, $RBRACKET, $RPAREN, $SEMICOLON, $SLASH, $SQ, $TAB, $VTAB, $X, $Z, $_, $a, $b, $f, $n, $r, $t, $u, $v, $x, $z, isAsciiHexDigit, isAsciiLetter, isDigit, isNewLine, isOctalDigit, isQuote, isWhitespace } from "../chars.mjs";
import { ParseError, ParseLocation, ParseSourceFile, ParseSourceSpan } from "../parse_util.mjs";
import { NAMED_ENTITIES } from "./entities.mjs";
import { TokenType } from "./tokens.mjs";

//#region ../compiler/src/ml_parser/lexer.ts
/**
* @license
* Copyright Google LLC All Rights Reserved.
*
* Use of this source code is governed by an MIT-style license that can be
* found in the LICENSE file at https://angular.dev/license
*/
var TokenizeResult = class {
	constructor(tokens, errors, nonNormalizedIcuExpressions) {
		this.tokens = tokens;
		this.errors = errors;
		this.nonNormalizedIcuExpressions = nonNormalizedIcuExpressions;
	}
};
function tokenize(source, url, getTagContentType, options = {}) {
	const tokenizer = new _Tokenizer(new ParseSourceFile(source, url), getTagContentType, options);
	tokenizer.tokenize();
	return new TokenizeResult(mergeTextTokens(tokenizer.tokens), tokenizer.errors, tokenizer.nonNormalizedIcuExpressions);
}
const _CR_OR_CRLF_REGEXP = /\r\n?/g;
function _unexpectedCharacterErrorMsg(charCode) {
	return `Unexpected character "${charCode === $EOF ? "EOF" : String.fromCharCode(charCode)}"`;
}
function _unknownEntityErrorMsg(entitySrc) {
	return `Unknown entity "${entitySrc}" - use the "&#<decimal>;" or  "&#x<hex>;" syntax`;
}
function _unparsableEntityErrorMsg(type, entityStr) {
	return `Unable to parse entity "${entityStr}" - ${type} character reference entities must end with ";"`;
}
var CharacterReferenceType = /* @__PURE__ */ function(CharacterReferenceType) {
	CharacterReferenceType["HEX"] = "hexadecimal";
	CharacterReferenceType["DEC"] = "decimal";
	return CharacterReferenceType;
}(CharacterReferenceType || {});
const SUPPORTED_BLOCKS = [
	"@if",
	"@else",
	"@for",
	"@switch",
	"@case",
	"@default",
	"@empty",
	"@defer",
	"@placeholder",
	"@loading",
	"@error"
];
const INTERPOLATION = {
	start: "{{",
	end: "}}"
};
var _Tokenizer = class {
	_cursor;
	_tokenizeIcu;
	_leadingTriviaCodePoints;
	_canSelfClose;
	_allowHtmComponentClosingTags;
	_currentTokenStart = null;
	_currentTokenType = null;
	_expansionCaseStack = [];
	_openDirectiveCount = 0;
	_inInterpolation = false;
	_preserveLineEndings;
	_i18nNormalizeLineEndingsInICUs;
	_fullNameStack = [];
	_tokenizeBlocks;
	_tokenizeLet;
	_selectorlessEnabled;
	tokens = [];
	errors = [];
	nonNormalizedIcuExpressions = [];
	/**
	* @param _file The html source file being tokenized.
	* @param _getTagContentType A function that will retrieve a tag content type for a given tag
	*     name.
	* @param options Configuration of the tokenization.
	*/
	constructor(_file, _getTagContentType, options) {
		this._getTagContentType = _getTagContentType;
		this._tokenizeIcu = options.tokenizeExpansionForms || false;
		this._leadingTriviaCodePoints = options.leadingTriviaChars && options.leadingTriviaChars.map((c) => c.codePointAt(0) || 0);
		this._canSelfClose = options.canSelfClose || false;
		this._allowHtmComponentClosingTags = options.allowHtmComponentClosingTags || false;
		const range = options.range || {
			endPos: _file.content.length,
			startPos: 0,
			startLine: 0,
			startCol: 0
		};
		this._cursor = options.escapedString ? new EscapedCharacterCursor(_file, range) : new PlainCharacterCursor(_file, range);
		this._preserveLineEndings = options.preserveLineEndings || false;
		this._i18nNormalizeLineEndingsInICUs = options.i18nNormalizeLineEndingsInICUs || false;
		this._tokenizeBlocks = options.tokenizeBlocks ?? true;
		this._tokenizeLet = options.tokenizeLet ?? true;
		this._selectorlessEnabled = options.selectorlessEnabled ?? false;
		try {
			this._cursor.init();
		} catch (e) {
			this.handleError(e);
		}
	}
	_processCarriageReturns(content) {
		if (this._preserveLineEndings) return content;
		return content.replace(_CR_OR_CRLF_REGEXP, "\n");
	}
	tokenize() {
		while (this._cursor.peek() !== $EOF) {
			const start = this._cursor.clone();
			try {
				if (this._attemptCharCode($LT)) if (this._attemptCharCode($BANG)) if (this._attemptStr("[CDATA[")) this._consumeCdata(start);
				else if (this._attemptStr("--")) this._consumeComment(start);
				else if (this._attemptStrCaseInsensitive("doctype")) this._consumeDocType(start);
				else this._consumeBogusComment(start);
				else if (this._attemptCharCode($SLASH)) this._consumeTagClose(start);
				else {
					const savedPos = this._cursor.clone();
					if (this._attemptCharCode($QUESTION)) {
						this._cursor = savedPos;
						this._consumeBogusComment(start);
					} else this._consumeTagOpen(start);
				}
				else if (this._tokenizeLet && this._cursor.peek() === $AT && !this._inInterpolation && this._isLetStart()) this._consumeLetDeclaration(start);
				else if (this._tokenizeBlocks && this._isBlockStart()) this._consumeBlockStart(start);
				else if (this._tokenizeBlocks && !this._inInterpolation && !this._isInExpansionCase() && !this._isInExpansionForm() && this._attemptCharCode($RBRACE)) this._consumeBlockEnd(start);
				else if (!(this._tokenizeIcu && this._tokenizeExpansionForm())) this._consumeWithInterpolation(TokenType.TEXT, TokenType.INTERPOLATION, () => this._isTextEnd(), () => this._isTagStart());
			} catch (e) {
				this.handleError(e);
			}
		}
		this._beginToken(TokenType.EOF);
		this._endToken([]);
	}
	_getBlockName() {
		let spacesInNameAllowed = false;
		const nameCursor = this._cursor.clone();
		this._attemptCharCodeUntilFn((code) => {
			if (isWhitespace(code)) return !spacesInNameAllowed;
			if (isBlockNameChar(code)) {
				spacesInNameAllowed = true;
				return false;
			}
			return true;
		});
		return this._cursor.getChars(nameCursor).trim();
	}
	_consumeBlockStart(start) {
		this._requireCharCode($AT);
		this._beginToken(TokenType.BLOCK_OPEN_START, start);
		const startToken = this._endToken([this._getBlockName()]);
		if (this._cursor.peek() === $LPAREN) {
			this._cursor.advance();
			this._consumeBlockParameters();
			this._attemptCharCodeUntilFn(isNotWhitespace);
			if (this._attemptCharCode($RPAREN)) this._attemptCharCodeUntilFn(isNotWhitespace);
			else {
				startToken.type = TokenType.INCOMPLETE_BLOCK_OPEN;
				return;
			}
		}
		if (this._attemptCharCode($LBRACE)) {
			this._beginToken(TokenType.BLOCK_OPEN_END);
			this._endToken([]);
		} else if (this._isBlockStart() && (startToken.parts[0] === "case" || startToken.parts[0] === "default")) {
			this._beginToken(TokenType.BLOCK_OPEN_END);
			this._endToken([]);
			this._beginToken(TokenType.BLOCK_CLOSE);
			this._endToken([]);
		} else startToken.type = TokenType.INCOMPLETE_BLOCK_OPEN;
	}
	_consumeBlockEnd(start) {
		this._beginToken(TokenType.BLOCK_CLOSE, start);
		this._endToken([]);
	}
	_consumeBlockParameters() {
		this._attemptCharCodeUntilFn(isBlockParameterChar);
		while (this._cursor.peek() !== $RPAREN && this._cursor.peek() !== $EOF) {
			this._beginToken(TokenType.BLOCK_PARAMETER);
			const start = this._cursor.clone();
			let inQuote = null;
			let openParens = 0;
			while (this._cursor.peek() !== $SEMICOLON && this._cursor.peek() !== $EOF || inQuote !== null) {
				const char = this._cursor.peek();
				if (char === $BACKSLASH) this._cursor.advance();
				else if (char === inQuote) inQuote = null;
				else if (inQuote === null && isQuote(char)) inQuote = char;
				else if (char === $LPAREN && inQuote === null) openParens++;
				else if (char === $RPAREN && inQuote === null) {
					if (openParens === 0) break;
					else if (openParens > 0) openParens--;
				}
				this._cursor.advance();
			}
			this._endToken([this._cursor.getChars(start)]);
			this._attemptCharCodeUntilFn(isBlockParameterChar);
		}
	}
	_consumeLetDeclaration(start) {
		this._requireStr("@let");
		this._beginToken(TokenType.LET_START, start);
		if (isWhitespace(this._cursor.peek())) this._attemptCharCodeUntilFn(isNotWhitespace);
		else {
			const token = this._endToken([this._cursor.getChars(start)]);
			token.type = TokenType.INCOMPLETE_LET;
			return;
		}
		const startToken = this._endToken([this._getLetDeclarationName()]);
		this._attemptCharCodeUntilFn(isNotWhitespace);
		if (!this._attemptCharCode($EQ)) {
			startToken.type = TokenType.INCOMPLETE_LET;
			return;
		}
		this._attemptCharCodeUntilFn((code) => isNotWhitespace(code) && !isNewLine(code));
		this._consumeLetDeclarationValue();
		if (this._cursor.peek() === $SEMICOLON) {
			this._beginToken(TokenType.LET_END);
			this._endToken([]);
			this._cursor.advance();
		} else {
			startToken.type = TokenType.INCOMPLETE_LET;
			startToken.sourceSpan = this._cursor.getSpan(start);
		}
	}
	_getLetDeclarationName() {
		const nameCursor = this._cursor.clone();
		let allowDigit = false;
		this._attemptCharCodeUntilFn((code) => {
			if (isAsciiLetter(code) || code === $$ || code === $_ || allowDigit && isDigit(code)) {
				allowDigit = true;
				return false;
			}
			return true;
		});
		return this._cursor.getChars(nameCursor).trim();
	}
	_consumeLetDeclarationValue() {
		const start = this._cursor.clone();
		this._beginToken(TokenType.LET_VALUE, start);
		while (this._cursor.peek() !== $EOF) {
			const char = this._cursor.peek();
			if (char === $SEMICOLON) break;
			if (isQuote(char)) {
				this._cursor.advance();
				this._attemptCharCodeUntilFn((inner) => {
					if (inner === $BACKSLASH) {
						this._cursor.advance();
						return false;
					}
					return inner === char;
				});
			}
			this._cursor.advance();
		}
		this._endToken([this._cursor.getChars(start)]);
	}
	/**
	* @returns whether an ICU token has been created
	* @internal
	*/
	_tokenizeExpansionForm() {
		if (this.isExpansionFormStart()) {
			this._consumeExpansionFormStart();
			return true;
		}
		if (isExpansionCaseStart(this._cursor.peek()) && this._isInExpansionForm()) {
			this._consumeExpansionCaseStart();
			return true;
		}
		if (this._cursor.peek() === $RBRACE) {
			if (this._isInExpansionCase()) {
				this._consumeExpansionCaseEnd();
				return true;
			}
			if (this._isInExpansionForm()) {
				this._consumeExpansionFormEnd();
				return true;
			}
		}
		return false;
	}
	_beginToken(type, start = this._cursor.clone()) {
		this._currentTokenStart = start;
		this._currentTokenType = type;
	}
	_endToken(parts, end) {
		if (this._currentTokenStart === null) throw new ParseError(this._cursor.getSpan(end), "Programming error - attempted to end a token when there was no start to the token");
		if (this._currentTokenType === null) throw new ParseError(this._cursor.getSpan(this._currentTokenStart), "Programming error - attempted to end a token which has no token type");
		const token = {
			type: this._currentTokenType,
			parts,
			sourceSpan: (end ?? this._cursor).getSpan(this._currentTokenStart, this._leadingTriviaCodePoints)
		};
		this.tokens.push(token);
		this._currentTokenStart = null;
		this._currentTokenType = null;
		return token;
	}
	_createError(msg, span) {
		if (this._isInExpansionForm()) msg += ` (Do you have an unescaped "{" in your template? Use "{{ '{' }}") to escape it.)`;
		const error = new ParseError(span, msg);
		this._currentTokenStart = null;
		this._currentTokenType = null;
		return error;
	}
	handleError(e) {
		if (e instanceof CursorError) e = this._createError(e.msg, this._cursor.getSpan(e.cursor));
		if (e instanceof ParseError) this.errors.push(e);
		else throw e;
	}
	_attemptCharCode(charCode) {
		if (this._cursor.peek() === charCode) {
			this._cursor.advance();
			return true;
		}
		return false;
	}
	_attemptCharCodeCaseInsensitive(charCode) {
		if (compareCharCodeCaseInsensitive(this._cursor.peek(), charCode)) {
			this._cursor.advance();
			return true;
		}
		return false;
	}
	_requireCharCode(charCode) {
		const location = this._cursor.clone();
		if (!this._attemptCharCode(charCode)) throw this._createError(_unexpectedCharacterErrorMsg(this._cursor.peek()), this._cursor.getSpan(location));
	}
	_attemptStr(chars) {
		const len = chars.length;
		if (this._cursor.charsLeft() < len) return false;
		const initialPosition = this._cursor.clone();
		for (let i = 0; i < len; i++) if (!this._attemptCharCode(chars.charCodeAt(i))) {
			this._cursor = initialPosition;
			return false;
		}
		return true;
	}
	_attemptStrCaseInsensitive(chars) {
		for (let i = 0; i < chars.length; i++) if (!this._attemptCharCodeCaseInsensitive(chars.charCodeAt(i))) return false;
		return true;
	}
	_requireStr(chars) {
		const location = this._cursor.clone();
		if (!this._attemptStr(chars)) throw this._createError(_unexpectedCharacterErrorMsg(this._cursor.peek()), this._cursor.getSpan(location));
	}
	_requireStrCaseInsensitive(chars) {
		const location = this._cursor.clone();
		if (!this._attemptStrCaseInsensitive(chars)) throw this._createError(_unexpectedCharacterErrorMsg(this._cursor.peek()), this._cursor.getSpan(location));
	}
	_attemptCharCodeUntilFn(predicate) {
		while (!predicate(this._cursor.peek())) this._cursor.advance();
	}
	_requireCharCodeUntilFn(predicate, len) {
		const start = this._cursor.clone();
		this._attemptCharCodeUntilFn(predicate);
		if (this._cursor.diff(start) < len) throw this._createError(_unexpectedCharacterErrorMsg(this._cursor.peek()), this._cursor.getSpan(start));
	}
	_attemptUntilChar(char) {
		while (this._cursor.peek() !== char) this._cursor.advance();
	}
	_readChar() {
		const char = String.fromCodePoint(this._cursor.peek());
		this._cursor.advance();
		return char;
	}
	_peekStr(chars) {
		const len = chars.length;
		if (this._cursor.charsLeft() < len) return false;
		const cursor = this._cursor.clone();
		for (let i = 0; i < len; i++) {
			if (cursor.peek() !== chars.charCodeAt(i)) return false;
			cursor.advance();
		}
		return true;
	}
	_isBlockStart() {
		return this._cursor.peek() === $AT && SUPPORTED_BLOCKS.some((blockName) => this._peekStr(blockName));
	}
	_isLetStart() {
		return this._cursor.peek() === $AT && this._peekStr("@let");
	}
	_consumeEntity(textTokenType) {
		this._beginToken(TokenType.ENCODED_ENTITY);
		const start = this._cursor.clone();
		this._cursor.advance();
		if (this._attemptCharCode($HASH)) {
			const isHex = this._attemptCharCode($x) || this._attemptCharCode($X);
			const codeStart = this._cursor.clone();
			this._attemptCharCodeUntilFn(isDigitEntityEnd);
			if (this._cursor.peek() != $SEMICOLON) {
				this._cursor.advance();
				const entityType = isHex ? CharacterReferenceType.HEX : CharacterReferenceType.DEC;
				throw this._createError(_unparsableEntityErrorMsg(entityType, this._cursor.getChars(start)), this._cursor.getSpan());
			}
			const strNum = this._cursor.getChars(codeStart);
			this._cursor.advance();
			try {
				const charCode = parseInt(strNum, isHex ? 16 : 10);
				this._endToken([String.fromCodePoint(charCode), this._cursor.getChars(start)]);
			} catch {
				throw this._createError(_unknownEntityErrorMsg(this._cursor.getChars(start)), this._cursor.getSpan());
			}
		} else {
			const nameStart = this._cursor.clone();
			this._attemptCharCodeUntilFn(isNamedEntityEnd);
			if (this._cursor.peek() != $SEMICOLON) {
				this._beginToken(textTokenType, start);
				this._cursor = nameStart;
				this._endToken(["&"]);
			} else {
				const name = this._cursor.getChars(nameStart);
				this._cursor.advance();
				const char = NAMED_ENTITIES.hasOwnProperty(name) && NAMED_ENTITIES[name];
				if (!char) throw this._createError(_unknownEntityErrorMsg(name), this._cursor.getSpan(start));
				this._endToken([char, `&${name};`]);
			}
		}
	}
	_consumeRawText(consumeEntities, endMarkerPredicate) {
		this._beginToken(consumeEntities ? TokenType.ESCAPABLE_RAW_TEXT : TokenType.RAW_TEXT);
		const parts = [];
		while (true) {
			const tagCloseStart = this._cursor.clone();
			const foundEndMarker = endMarkerPredicate();
			this._cursor = tagCloseStart;
			if (foundEndMarker) break;
			if (consumeEntities && this._cursor.peek() === $AMPERSAND) {
				this._endToken([this._processCarriageReturns(parts.join(""))]);
				parts.length = 0;
				this._consumeEntity(TokenType.ESCAPABLE_RAW_TEXT);
				this._beginToken(TokenType.ESCAPABLE_RAW_TEXT);
			} else parts.push(this._readChar());
		}
		this._endToken([this._processCarriageReturns(parts.join(""))]);
	}
	_consumeComment(start) {
		this._beginToken(TokenType.COMMENT_START, start);
		this._endToken([]);
		this._consumeRawText(false, () => this._attemptStr("-->"));
		this._beginToken(TokenType.COMMENT_END);
		this._requireStr("-->");
		this._endToken([]);
	}
	_consumeBogusComment(start) {
		this._beginToken(TokenType.COMMENT_START, start);
		this._endToken([]);
		this._consumeRawText(false, () => this._cursor.peek() === $GT);
		this._beginToken(TokenType.COMMENT_END);
		this._cursor.advance();
		this._endToken([]);
	}
	_consumeCdata(start) {
		this._beginToken(TokenType.CDATA_START, start);
		this._endToken([]);
		this._consumeRawText(false, () => this._attemptStr("]]>"));
		this._beginToken(TokenType.CDATA_END);
		this._requireStr("]]>");
		this._endToken([]);
	}
	_consumeDocType(start) {
		this._beginToken(TokenType.DOC_TYPE_START, start);
		this._endToken([]);
		this._consumeRawText(false, () => this._cursor.peek() === $GT);
		this._beginToken(TokenType.DOC_TYPE_END);
		this._cursor.advance();
		this._endToken([]);
	}
	_consumePrefixAndName(endPredicate) {
		const nameOrPrefixStart = this._cursor.clone();
		let prefix = "";
		while (this._cursor.peek() !== $COLON && !isPrefixEnd(this._cursor.peek())) this._cursor.advance();
		let nameStart;
		if (this._cursor.peek() === $COLON) {
			prefix = this._cursor.getChars(nameOrPrefixStart);
			this._cursor.advance();
			nameStart = this._cursor.clone();
		} else nameStart = nameOrPrefixStart;
		this._requireCharCodeUntilFn(endPredicate, prefix === "" ? 0 : 1);
		const name = this._cursor.getChars(nameStart);
		return [prefix, name];
	}
	_consumeTagOpen(start) {
		let tagName;
		let prefix;
		let closingTagName;
		let openToken;
		const attrs = [];
		try {
			if (this._selectorlessEnabled && isSelectorlessNameStart(this._cursor.peek())) {
				openToken = this._consumeComponentOpenStart(start);
				[closingTagName, prefix, tagName] = openToken.parts;
				if (prefix) closingTagName += `:${prefix}`;
				if (tagName) closingTagName += `:${tagName}`;
				this._attemptCharCodeUntilFn(isNotWhitespace);
			} else {
				if (!isAsciiLetter(this._cursor.peek())) throw this._createError(_unexpectedCharacterErrorMsg(this._cursor.peek()), this._cursor.getSpan(start));
				openToken = this._consumeTagOpenStart(start);
				prefix = openToken.parts[0];
				tagName = closingTagName = openToken.parts[1];
				this._attemptCharCodeUntilFn(isNotWhitespace);
			}
			while (!isAttributeTerminator(this._cursor.peek())) if (this._selectorlessEnabled && this._cursor.peek() === $AT) {
				const start$1 = this._cursor.clone();
				const nameStart = start$1.clone();
				nameStart.advance();
				if (isSelectorlessNameStart(nameStart.peek())) this._consumeDirective(start$1, nameStart);
			} else {
				const attr = this._consumeAttribute();
				attrs.push(attr);
			}
			if (openToken.type === TokenType.COMPONENT_OPEN_START) this._consumeComponentOpenEnd();
			else this._consumeTagOpenEnd();
		} catch (e) {
			if (e instanceof ParseError) {
				if (openToken) openToken.type = openToken.type === TokenType.COMPONENT_OPEN_START ? TokenType.INCOMPLETE_COMPONENT_OPEN : TokenType.INCOMPLETE_TAG_OPEN;
				else {
					this._beginToken(TokenType.TEXT, start);
					this._endToken(["<"]);
				}
				return;
			}
			throw e;
		}
		if (this._canSelfClose && this.tokens[this.tokens.length - 1].type === TokenType.TAG_OPEN_END_VOID) return;
		const contentTokenType = this._getTagContentType(tagName, prefix, this._fullNameStack.length > 0, attrs);
		this._handleFullNameStackForTagOpen(prefix, tagName);
		if (contentTokenType === TagContentType.RAW_TEXT) this._consumeRawTextWithTagClose(prefix, openToken, closingTagName, false);
		else if (contentTokenType === TagContentType.ESCAPABLE_RAW_TEXT) this._consumeRawTextWithTagClose(prefix, openToken, closingTagName, true);
	}
	_consumeRawTextWithTagClose(prefix, openToken, tagName, consumeEntities) {
		this._consumeRawText(consumeEntities, () => {
			if (!this._attemptCharCode($LT)) return false;
			if (!this._attemptCharCode($SLASH)) return false;
			this._attemptCharCodeUntilFn(isNotWhitespace);
			if (!this._attemptStrCaseInsensitive(prefix && openToken.type !== TokenType.COMPONENT_OPEN_START ? `${prefix}:${tagName}` : tagName)) return false;
			this._attemptCharCodeUntilFn(isNotWhitespace);
			return this._attemptCharCode($GT);
		});
		this._beginToken(openToken.type === TokenType.COMPONENT_OPEN_START ? TokenType.COMPONENT_CLOSE : TokenType.TAG_CLOSE);
		this._requireCharCodeUntilFn((code) => code === $GT, 3);
		this._cursor.advance();
		this._endToken(openToken.parts);
		this._handleFullNameStackForTagClose(prefix, tagName);
	}
	_consumeTagOpenStart(start) {
		this._beginToken(TokenType.TAG_OPEN_START, start);
		const parts = this._consumePrefixAndName(isNameEnd);
		return this._endToken(parts);
	}
	_consumeComponentOpenStart(start) {
		this._beginToken(TokenType.COMPONENT_OPEN_START, start);
		const parts = this._consumeComponentName();
		return this._endToken(parts);
	}
	_consumeComponentName() {
		const nameStart = this._cursor.clone();
		while (isSelectorlessNameChar(this._cursor.peek())) this._cursor.advance();
		const name = this._cursor.getChars(nameStart);
		let prefix = "";
		let tagName = "";
		if (this._cursor.peek() === $COLON) {
			this._cursor.advance();
			[prefix, tagName] = this._consumePrefixAndName(isNameEnd);
		}
		return [
			name,
			prefix,
			tagName
		];
	}
	_consumeAttribute() {
		const [prefix, name] = this._consumeAttributeName();
		let value;
		this._attemptCharCodeUntilFn(isNotWhitespace);
		if (this._attemptCharCode($EQ)) {
			this._attemptCharCodeUntilFn(isNotWhitespace);
			value = this._consumeAttributeValue();
		}
		this._attemptCharCodeUntilFn(isNotWhitespace);
		return {
			prefix,
			name,
			value
		};
	}
	_consumeAttributeName() {
		const attrNameStart = this._cursor.peek();
		if (attrNameStart === $SQ || attrNameStart === $DQ) throw this._createError(_unexpectedCharacterErrorMsg(attrNameStart), this._cursor.getSpan());
		this._beginToken(TokenType.ATTR_NAME);
		let nameEndPredicate;
		if (this._openDirectiveCount > 0) {
			let openParens = 0;
			nameEndPredicate = (code) => {
				if (this._openDirectiveCount > 0) {
					if (code === $LPAREN) openParens++;
					else if (code === $RPAREN) {
						if (openParens === 0) return true;
						openParens--;
					}
				}
				return isNameEnd(code);
			};
		} else if (attrNameStart === $LBRACKET) {
			let openBrackets = 0;
			nameEndPredicate = (code) => {
				if (code === $LBRACKET) openBrackets++;
				else if (code === $RBRACKET) openBrackets--;
				return openBrackets <= 0 ? isNameEnd(code) : isNewLine(code);
			};
		} else nameEndPredicate = isNameEnd;
		const prefixAndName = this._consumePrefixAndName(nameEndPredicate);
		this._endToken(prefixAndName);
		return prefixAndName;
	}
	_consumeAttributeValue() {
		let value;
		if (this._cursor.peek() === $SQ || this._cursor.peek() === $DQ) {
			const quoteChar = this._cursor.peek();
			this._consumeQuote(quoteChar);
			const endPredicate = () => this._cursor.peek() === quoteChar;
			value = this._consumeWithInterpolation(TokenType.ATTR_VALUE_TEXT, TokenType.ATTR_VALUE_INTERPOLATION, endPredicate, endPredicate);
			this._consumeQuote(quoteChar);
		} else {
			const endPredicate = () => isNameEnd(this._cursor.peek());
			value = this._consumeWithInterpolation(TokenType.ATTR_VALUE_TEXT, TokenType.ATTR_VALUE_INTERPOLATION, endPredicate, endPredicate);
		}
		return value;
	}
	_consumeQuote(quoteChar) {
		this._beginToken(TokenType.ATTR_QUOTE);
		this._requireCharCode(quoteChar);
		this._endToken([String.fromCodePoint(quoteChar)]);
	}
	_consumeTagOpenEnd() {
		const tokenType = this._attemptCharCode($SLASH) ? TokenType.TAG_OPEN_END_VOID : TokenType.TAG_OPEN_END;
		this._beginToken(tokenType);
		this._requireCharCode($GT);
		this._endToken([]);
	}
	_consumeComponentOpenEnd() {
		const tokenType = this._attemptCharCode($SLASH) ? TokenType.COMPONENT_OPEN_END_VOID : TokenType.COMPONENT_OPEN_END;
		this._beginToken(tokenType);
		this._requireCharCode($GT);
		this._endToken([]);
	}
	_consumeTagClose(start) {
		if (this._selectorlessEnabled) {
			const clone = start.clone();
			while (clone.peek() !== $GT && !isSelectorlessNameStart(clone.peek())) clone.advance();
			if (isSelectorlessNameStart(clone.peek())) {
				this._beginToken(TokenType.COMPONENT_CLOSE, start);
				const parts = this._consumeComponentName();
				this._attemptCharCodeUntilFn(isNotWhitespace);
				this._requireCharCode($GT);
				this._endToken(parts);
				return;
			}
		}
		this._beginToken(TokenType.TAG_CLOSE, start);
		this._attemptCharCodeUntilFn(isNotWhitespace);
		if (this._allowHtmComponentClosingTags && this._attemptCharCode($SLASH)) {
			this._attemptCharCodeUntilFn(isNotWhitespace);
			this._requireCharCode($GT);
			this._endToken([]);
		} else {
			const [prefix, name] = this._consumePrefixAndName(isNameEnd);
			this._attemptCharCodeUntilFn(isNotWhitespace);
			this._requireCharCode($GT);
			this._endToken([prefix, name]);
			this._handleFullNameStackForTagClose(prefix, name);
		}
	}
	_consumeExpansionFormStart() {
		this._beginToken(TokenType.EXPANSION_FORM_START);
		this._requireCharCode($LBRACE);
		this._endToken([]);
		this._expansionCaseStack.push(TokenType.EXPANSION_FORM_START);
		this._beginToken(TokenType.RAW_TEXT);
		const condition = this._readUntil($COMMA);
		const normalizedCondition = this._processCarriageReturns(condition);
		if (this._i18nNormalizeLineEndingsInICUs) this._endToken([normalizedCondition]);
		else {
			const conditionToken = this._endToken([condition]);
			if (normalizedCondition !== condition) this.nonNormalizedIcuExpressions.push(conditionToken);
		}
		this._requireCharCode($COMMA);
		this._attemptCharCodeUntilFn(isNotWhitespace);
		this._beginToken(TokenType.RAW_TEXT);
		const type = this._readUntil($COMMA);
		this._endToken([type]);
		this._requireCharCode($COMMA);
		this._attemptCharCodeUntilFn(isNotWhitespace);
	}
	_consumeExpansionCaseStart() {
		this._beginToken(TokenType.EXPANSION_CASE_VALUE);
		const value = this._readUntil($LBRACE).trim();
		this._endToken([value]);
		this._attemptCharCodeUntilFn(isNotWhitespace);
		this._beginToken(TokenType.EXPANSION_CASE_EXP_START);
		this._requireCharCode($LBRACE);
		this._endToken([]);
		this._attemptCharCodeUntilFn(isNotWhitespace);
		this._expansionCaseStack.push(TokenType.EXPANSION_CASE_EXP_START);
	}
	_consumeExpansionCaseEnd() {
		this._beginToken(TokenType.EXPANSION_CASE_EXP_END);
		this._requireCharCode($RBRACE);
		this._endToken([]);
		this._attemptCharCodeUntilFn(isNotWhitespace);
		this._expansionCaseStack.pop();
	}
	_consumeExpansionFormEnd() {
		this._beginToken(TokenType.EXPANSION_FORM_END);
		this._requireCharCode($RBRACE);
		this._endToken([]);
		this._expansionCaseStack.pop();
	}
	/**
	* Consume a string that may contain interpolation expressions.
	*
	* The first token consumed will be of `tokenType` and then there will be alternating
	* `interpolationTokenType` and `tokenType` tokens until the `endPredicate()` returns true.
	*
	* If an interpolation token ends prematurely it will have no end marker in its `parts` array.
	*
	* @param textTokenType the kind of tokens to interleave around interpolation tokens.
	* @param interpolationTokenType the kind of tokens that contain interpolation.
	* @param endPredicate a function that should return true when we should stop consuming.
	* @param endInterpolation a function that should return true if there is a premature end to an
	*     interpolation expression - i.e. before we get to the normal interpolation closing marker.
	*/
	_consumeWithInterpolation(textTokenType, interpolationTokenType, endPredicate, endInterpolation) {
		this._beginToken(textTokenType);
		const parts = [];
		while (!endPredicate()) {
			const current = this._cursor.clone();
			if (this._attemptStr(INTERPOLATION.start)) {
				this._endToken([this._processCarriageReturns(parts.join(""))], current);
				parts.length = 0;
				this._consumeInterpolation(interpolationTokenType, current, endInterpolation);
				this._beginToken(textTokenType);
			} else if (this._cursor.peek() === $AMPERSAND) {
				this._endToken([this._processCarriageReturns(parts.join(""))]);
				parts.length = 0;
				this._consumeEntity(textTokenType);
				this._beginToken(textTokenType);
			} else parts.push(this._readChar());
		}
		this._inInterpolation = false;
		const value = this._processCarriageReturns(parts.join(""));
		this._endToken([value]);
		return value;
	}
	/**
	* Consume a block of text that has been interpreted as an Angular interpolation.
	*
	* @param interpolationTokenType the type of the interpolation token to generate.
	* @param interpolationStart a cursor that points to the start of this interpolation.
	* @param prematureEndPredicate a function that should return true if the next characters indicate
	*     an end to the interpolation before its normal closing marker.
	*/
	_consumeInterpolation(interpolationTokenType, interpolationStart, prematureEndPredicate) {
		const parts = [];
		this._beginToken(interpolationTokenType, interpolationStart);
		parts.push(INTERPOLATION.start);
		const expressionStart = this._cursor.clone();
		let inQuote = null;
		let inComment = false;
		while (this._cursor.peek() !== $EOF && (prematureEndPredicate === null || !prematureEndPredicate())) {
			const current = this._cursor.clone();
			if (this._isTagStart()) {
				this._cursor = current;
				parts.push(this._getProcessedChars(expressionStart, current));
				this._endToken(parts);
				return;
			}
			if (inQuote === null) {
				if (this._attemptStr(INTERPOLATION.end)) {
					parts.push(this._getProcessedChars(expressionStart, current));
					parts.push(INTERPOLATION.end);
					this._endToken(parts);
					return;
				} else if (this._attemptStr("//")) inComment = true;
			}
			const char = this._cursor.peek();
			this._cursor.advance();
			if (char === $BACKSLASH) this._cursor.advance();
			else if (char === inQuote) inQuote = null;
			else if (!inComment && inQuote === null && isQuote(char)) inQuote = char;
		}
		parts.push(this._getProcessedChars(expressionStart, this._cursor));
		this._endToken(parts);
	}
	_consumeDirective(start, nameStart) {
		this._requireCharCode($AT);
		this._cursor.advance();
		while (isSelectorlessNameChar(this._cursor.peek())) this._cursor.advance();
		this._beginToken(TokenType.DIRECTIVE_NAME, start);
		const name = this._cursor.getChars(nameStart);
		this._endToken([name]);
		this._attemptCharCodeUntilFn(isNotWhitespace);
		if (this._cursor.peek() !== $LPAREN) return;
		this._openDirectiveCount++;
		this._beginToken(TokenType.DIRECTIVE_OPEN);
		this._cursor.advance();
		this._endToken([]);
		this._attemptCharCodeUntilFn(isNotWhitespace);
		while (!isAttributeTerminator(this._cursor.peek()) && this._cursor.peek() !== $RPAREN) this._consumeAttribute();
		this._attemptCharCodeUntilFn(isNotWhitespace);
		this._openDirectiveCount--;
		if (this._cursor.peek() !== $RPAREN) {
			if (this._cursor.peek() === $GT || this._cursor.peek() === $SLASH) return;
			throw this._createError(_unexpectedCharacterErrorMsg(this._cursor.peek()), this._cursor.getSpan(start));
		}
		this._beginToken(TokenType.DIRECTIVE_CLOSE);
		this._cursor.advance();
		this._endToken([]);
		this._attemptCharCodeUntilFn(isNotWhitespace);
	}
	_getProcessedChars(start, end) {
		return this._processCarriageReturns(end.getChars(start));
	}
	_isTextEnd() {
		if (this._isTagStart() || this._cursor.peek() === $EOF) return true;
		if (this._tokenizeIcu && !this._inInterpolation) {
			if (this.isExpansionFormStart()) return true;
			if (this._cursor.peek() === $RBRACE && this._isInExpansionCase()) return true;
		}
		if (this._tokenizeBlocks && !this._inInterpolation && !this._isInExpansion() && (this._isBlockStart() || this._isLetStart() || this._cursor.peek() === $RBRACE)) return true;
		return false;
	}
	/**
	* Returns true if the current cursor is pointing to the start of a tag
	* (opening/closing/comments/cdata/etc).
	*/
	_isTagStart() {
		if (this._cursor.peek() === $LT) {
			const tmp = this._cursor.clone();
			tmp.advance();
			const code = tmp.peek();
			if ($a <= code && code <= $z || $A <= code && code <= $Z || code === $SLASH || code === $BANG) return true;
		}
		return false;
	}
	_readUntil(char) {
		const start = this._cursor.clone();
		this._attemptUntilChar(char);
		return this._cursor.getChars(start);
	}
	_isInExpansion() {
		return this._isInExpansionCase() || this._isInExpansionForm();
	}
	_isInExpansionCase() {
		return this._expansionCaseStack.length > 0 && this._expansionCaseStack[this._expansionCaseStack.length - 1] === TokenType.EXPANSION_CASE_EXP_START;
	}
	_isInExpansionForm() {
		return this._expansionCaseStack.length > 0 && this._expansionCaseStack[this._expansionCaseStack.length - 1] === TokenType.EXPANSION_FORM_START;
	}
	isExpansionFormStart() {
		if (this._cursor.peek() !== $LBRACE) return false;
		const start = this._cursor.clone();
		const isInterpolation = this._attemptStr(INTERPOLATION.start);
		this._cursor = start;
		return !isInterpolation;
	}
	_handleFullNameStackForTagOpen(prefix, tagName) {
		const fullName = mergeNsAndName(prefix, tagName);
		if (this._fullNameStack.length === 0 || this._fullNameStack[this._fullNameStack.length - 1] === fullName) this._fullNameStack.push(fullName);
	}
	_handleFullNameStackForTagClose(prefix, tagName) {
		const fullName = mergeNsAndName(prefix, tagName);
		if (this._fullNameStack.length !== 0 && this._fullNameStack[this._fullNameStack.length - 1] === fullName) this._fullNameStack.pop();
	}
};
function isNotWhitespace(code) {
	return !isWhitespace(code) || code === $EOF;
}
function isNameEnd(code) {
	return isWhitespace(code) || code === $GT || code === $LT || code === $SLASH || code === $SQ || code === $DQ || code === $EQ || code === $EOF;
}
function isPrefixEnd(code) {
	return (code < $a || $z < code) && (code < $A || $Z < code) && (code < $0 || code > $9);
}
function isDigitEntityEnd(code) {
	return code === $SEMICOLON || code === $EOF || !isAsciiHexDigit(code);
}
function isNamedEntityEnd(code) {
	return code === $SEMICOLON || code === $EOF || !isAsciiLetter(code);
}
function isExpansionCaseStart(peek) {
	return peek !== $RBRACE;
}
function compareCharCodeCaseInsensitive(code1, code2) {
	return toUpperCaseCharCode(code1) === toUpperCaseCharCode(code2);
}
function toUpperCaseCharCode(code) {
	return code >= $a && code <= $z ? code - $a + $A : code;
}
function isBlockNameChar(code) {
	return isAsciiLetter(code) || isDigit(code) || code === $_;
}
function isBlockParameterChar(code) {
	return code !== $SEMICOLON && isNotWhitespace(code);
}
function isSelectorlessNameStart(code) {
	return code === $_ || code >= $A && code <= $Z;
}
function isSelectorlessNameChar(code) {
	return isAsciiLetter(code) || isDigit(code) || code === $_;
}
function isAttributeTerminator(code) {
	return code === $SLASH || code === $GT || code === $LT || code === $EOF;
}
function mergeTextTokens(srcTokens) {
	const dstTokens = [];
	let lastDstToken = void 0;
	for (let i = 0; i < srcTokens.length; i++) {
		const token = srcTokens[i];
		if (lastDstToken && lastDstToken.type === TokenType.TEXT && token.type === TokenType.TEXT || lastDstToken && lastDstToken.type === TokenType.ATTR_VALUE_TEXT && token.type === TokenType.ATTR_VALUE_TEXT) {
			lastDstToken.parts[0] += token.parts[0];
			lastDstToken.sourceSpan.end = token.sourceSpan.end;
		} else {
			lastDstToken = token;
			dstTokens.push(lastDstToken);
		}
	}
	return dstTokens;
}
var PlainCharacterCursor = class PlainCharacterCursor {
	state;
	file;
	input;
	end;
	constructor(fileOrCursor, range) {
		if (fileOrCursor instanceof PlainCharacterCursor) {
			this.file = fileOrCursor.file;
			this.input = fileOrCursor.input;
			this.end = fileOrCursor.end;
			const state = fileOrCursor.state;
			this.state = {
				peek: state.peek,
				offset: state.offset,
				line: state.line,
				column: state.column
			};
		} else {
			if (!range) throw new Error("Programming error: the range argument must be provided with a file argument.");
			this.file = fileOrCursor;
			this.input = fileOrCursor.content;
			this.end = range.endPos;
			this.state = {
				peek: -1,
				offset: range.startPos,
				line: range.startLine,
				column: range.startCol
			};
		}
	}
	clone() {
		return new PlainCharacterCursor(this);
	}
	peek() {
		return this.state.peek;
	}
	charsLeft() {
		return this.end - this.state.offset;
	}
	diff(other) {
		return this.state.offset - other.state.offset;
	}
	advance() {
		this.advanceState(this.state);
	}
	init() {
		this.updatePeek(this.state);
	}
	getSpan(start, leadingTriviaCodePoints) {
		start = start || this;
		let fullStart = start;
		if (leadingTriviaCodePoints) while (this.diff(start) > 0 && leadingTriviaCodePoints.indexOf(start.peek()) !== -1) {
			if (fullStart === start) start = start.clone();
			start.advance();
		}
		const startLocation = this.locationFromCursor(start);
		return new ParseSourceSpan(startLocation, this.locationFromCursor(this), fullStart !== start ? this.locationFromCursor(fullStart) : startLocation);
	}
	getChars(start) {
		return this.input.substring(start.state.offset, this.state.offset);
	}
	charAt(pos) {
		return this.input.charCodeAt(pos);
	}
	advanceState(state) {
		if (state.offset >= this.end) {
			this.state = state;
			throw new CursorError("Unexpected character \"EOF\"", this);
		}
		const currentChar = this.charAt(state.offset);
		if (currentChar === $LF) {
			state.line++;
			state.column = 0;
		} else if (!isNewLine(currentChar)) state.column++;
		state.offset++;
		this.updatePeek(state);
	}
	updatePeek(state) {
		state.peek = state.offset >= this.end ? $EOF : this.charAt(state.offset);
	}
	locationFromCursor(cursor) {
		return new ParseLocation(cursor.file, cursor.state.offset, cursor.state.line, cursor.state.column);
	}
};
var EscapedCharacterCursor = class EscapedCharacterCursor extends PlainCharacterCursor {
	internalState;
	constructor(fileOrCursor, range) {
		if (fileOrCursor instanceof EscapedCharacterCursor) {
			super(fileOrCursor);
			this.internalState = { ...fileOrCursor.internalState };
		} else {
			super(fileOrCursor, range);
			this.internalState = this.state;
		}
	}
	advance() {
		this.state = this.internalState;
		super.advance();
		this.processEscapeSequence();
	}
	init() {
		super.init();
		this.processEscapeSequence();
	}
	clone() {
		return new EscapedCharacterCursor(this);
	}
	getChars(start) {
		const cursor = start.clone();
		let chars = "";
		while (cursor.internalState.offset < this.internalState.offset) {
			chars += String.fromCodePoint(cursor.peek());
			cursor.advance();
		}
		return chars;
	}
	/**
	* Process the escape sequence that starts at the current position in the text.
	*
	* This method is called to ensure that `peek` has the unescaped value of escape sequences.
	*/
	processEscapeSequence() {
		const peek = () => this.internalState.peek;
		if (peek() === $BACKSLASH) {
			this.internalState = { ...this.state };
			this.advanceState(this.internalState);
			if (peek() === $n) this.state.peek = $LF;
			else if (peek() === $r) this.state.peek = $CR;
			else if (peek() === $v) this.state.peek = $VTAB;
			else if (peek() === $t) this.state.peek = $TAB;
			else if (peek() === $b) this.state.peek = $BSPACE;
			else if (peek() === $f) this.state.peek = $FF;
			else if (peek() === $u) {
				this.advanceState(this.internalState);
				if (peek() === $LBRACE) {
					this.advanceState(this.internalState);
					const digitStart = this.clone();
					let length = 0;
					while (peek() !== $RBRACE) {
						this.advanceState(this.internalState);
						length++;
					}
					this.state.peek = this.decodeHexDigits(digitStart, length);
				} else {
					const digitStart = this.clone();
					this.advanceState(this.internalState);
					this.advanceState(this.internalState);
					this.advanceState(this.internalState);
					this.state.peek = this.decodeHexDigits(digitStart, 4);
				}
			} else if (peek() === $x) {
				this.advanceState(this.internalState);
				const digitStart = this.clone();
				this.advanceState(this.internalState);
				this.state.peek = this.decodeHexDigits(digitStart, 2);
			} else if (isOctalDigit(peek())) {
				let octal = "";
				let length = 0;
				let previous = this.clone();
				while (isOctalDigit(peek()) && length < 3) {
					previous = this.clone();
					octal += String.fromCodePoint(peek());
					this.advanceState(this.internalState);
					length++;
				}
				this.state.peek = parseInt(octal, 8);
				this.internalState = previous.internalState;
			} else if (isNewLine(this.internalState.peek)) {
				this.advanceState(this.internalState);
				this.state = this.internalState;
			} else this.state.peek = this.internalState.peek;
		}
	}
	decodeHexDigits(start, length) {
		const hex = this.input.slice(start.internalState.offset, start.internalState.offset + length);
		const charCode = parseInt(hex, 16);
		if (!isNaN(charCode)) return charCode;
		else {
			start.state = start.internalState;
			throw new CursorError("Invalid hexadecimal escape sequence", start);
		}
	}
};
var CursorError = class extends Error {
	constructor(msg, cursor) {
		super(msg);
		this.msg = msg;
		this.cursor = cursor;
		Object.setPrototypeOf(this, new.target.prototype);
	}
};

//#endregion
export { tokenize };