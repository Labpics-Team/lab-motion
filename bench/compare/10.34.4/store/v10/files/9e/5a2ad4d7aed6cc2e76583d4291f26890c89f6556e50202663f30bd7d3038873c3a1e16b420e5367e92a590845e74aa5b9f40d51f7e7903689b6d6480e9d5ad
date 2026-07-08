import { getNsPrefix, mergeNsAndName, splitNsName } from "./tags.mjs";
import { ParseError, ParseSourceSpan } from "../parse_util.mjs";
import { Attribute, Block, BlockParameter, CDATA, Comment, Component, Directive, DocType, Element, Expansion, ExpansionCase, LetDeclaration, Text } from "./ast.mjs";
import { NAMED_ENTITIES } from "./entities.mjs";
import { TokenType } from "./tokens.mjs";
import { tokenize } from "./lexer.mjs";

//#region ../compiler/src/ml_parser/parser.ts
/**
* @license
* Copyright Google LLC All Rights Reserved.
*
* Use of this source code is governed by an MIT-style license that can be
* found in the LICENSE file at https://angular.dev/license
*/
var TreeError = class TreeError extends ParseError {
	static create(elementName, span, msg) {
		return new TreeError(elementName, span, msg);
	}
	constructor(elementName, span, msg) {
		super(span, msg);
		this.elementName = elementName;
	}
};
var ParseTreeResult = class {
	constructor(rootNodes, errors) {
		this.rootNodes = rootNodes;
		this.errors = errors;
	}
};
var Parser = class {
	constructor(getTagDefinition) {
		this.getTagDefinition = getTagDefinition;
	}
	parse(source, url, options, isTagNameCaseSensitive = false, getTagContentType) {
		const lowercasify = (fn) => (x, ...args) => fn(x.toLowerCase(), ...args);
		const getTagDefinition = isTagNameCaseSensitive ? this.getTagDefinition : lowercasify(this.getTagDefinition);
		const getDefaultTagContentType = (tagName) => getTagDefinition(tagName).getContentType();
		const getTagContentTypeWithProcessedTagName = isTagNameCaseSensitive ? getTagContentType : lowercasify(getTagContentType);
		const tokenizeResult = tokenize(source, url, getTagContentType ? (tagName, prefix, hasParent, attrs) => {
			const contentType = getTagContentTypeWithProcessedTagName(tagName, prefix, hasParent, attrs);
			return contentType !== void 0 ? contentType : getDefaultTagContentType(tagName);
		} : getDefaultTagContentType, options);
		const canSelfClose = options && options.canSelfClose || false;
		const allowHtmComponentClosingTags = options && options.allowHtmComponentClosingTags || false;
		const parser = new _TreeBuilder(tokenizeResult.tokens, getTagDefinition, canSelfClose, allowHtmComponentClosingTags, isTagNameCaseSensitive);
		parser.build();
		return new ParseTreeResult(parser.rootNodes, [...tokenizeResult.errors, ...parser.errors]);
	}
};
var _TreeBuilder = class _TreeBuilder {
	_index = -1;
	_peek;
	_containerStack = [];
	rootNodes = [];
	errors = [];
	constructor(tokens, tagDefinitionResolver, canSelfClose, allowHtmComponentClosingTags, isTagNameCaseSensitive) {
		this.tokens = tokens;
		this.tagDefinitionResolver = tagDefinitionResolver;
		this.canSelfClose = canSelfClose;
		this.allowHtmComponentClosingTags = allowHtmComponentClosingTags;
		this.isTagNameCaseSensitive = isTagNameCaseSensitive;
		this._advance();
	}
	build() {
		while (this._peek.type !== TokenType.EOF) if (this._peek.type === TokenType.TAG_OPEN_START || this._peek.type === TokenType.INCOMPLETE_TAG_OPEN) this._consumeElementStartTag(this._advance());
		else if (this._peek.type === TokenType.TAG_CLOSE) {
			this._closeVoidElement();
			this._consumeElementEndTag(this._advance());
		} else if (this._peek.type === TokenType.CDATA_START) {
			this._closeVoidElement();
			this._consumeCdata(this._advance());
		} else if (this._peek.type === TokenType.COMMENT_START) {
			this._closeVoidElement();
			this._consumeComment(this._advance());
		} else if (this._peek.type === TokenType.TEXT || this._peek.type === TokenType.RAW_TEXT || this._peek.type === TokenType.ESCAPABLE_RAW_TEXT) {
			this._closeVoidElement();
			this._consumeText(this._advance());
		} else if (this._peek.type === TokenType.EXPANSION_FORM_START) this._consumeExpansion(this._advance());
		else if (this._peek.type === TokenType.BLOCK_OPEN_START) {
			this._closeVoidElement();
			this._consumeBlockOpen(this._advance());
		} else if (this._peek.type === TokenType.BLOCK_CLOSE) {
			this._closeVoidElement();
			this._consumeBlockClose(this._advance());
		} else if (this._peek.type === TokenType.INCOMPLETE_BLOCK_OPEN) {
			this._closeVoidElement();
			this._consumeIncompleteBlock(this._advance());
		} else if (this._peek.type === TokenType.LET_START) {
			this._closeVoidElement();
			this._consumeLet(this._advance());
		} else if (this._peek.type === TokenType.DOC_TYPE_START) this._consumeDocType(this._advance());
		else if (this._peek.type === TokenType.INCOMPLETE_LET) {
			this._closeVoidElement();
			this._consumeIncompleteLet(this._advance());
		} else if (this._peek.type === TokenType.COMPONENT_OPEN_START || this._peek.type === TokenType.INCOMPLETE_COMPONENT_OPEN) this._consumeComponentStartTag(this._advance());
		else if (this._peek.type === TokenType.COMPONENT_CLOSE) this._consumeComponentEndTag(this._advance());
		else this._advance();
		for (const leftoverContainer of this._containerStack) if (leftoverContainer instanceof Block) this.errors.push(TreeError.create(leftoverContainer.name, leftoverContainer.sourceSpan, `Unclosed block "${leftoverContainer.name}"`));
	}
	_advance() {
		const prev = this._peek;
		if (this._index < this.tokens.length - 1) this._index++;
		this._peek = this.tokens[this._index];
		return prev;
	}
	_advanceIf(type) {
		if (this._peek.type === type) return this._advance();
		return null;
	}
	_consumeCdata(startToken) {
		const text = this._advance();
		const value = this._getText(text);
		const endToken = this._advanceIf(TokenType.CDATA_END);
		this._addToParent(new CDATA(value, new ParseSourceSpan(startToken.sourceSpan.start, (endToken || text).sourceSpan.end), [text]));
	}
	_consumeComment(token) {
		const text = this._advanceIf(TokenType.RAW_TEXT);
		const endToken = this._advanceIf(TokenType.COMMENT_END);
		const value = text != null ? text.parts[0].trim() : null;
		const sourceSpan = endToken == null ? token.sourceSpan : new ParseSourceSpan(token.sourceSpan.start, endToken.sourceSpan.end, token.sourceSpan.fullStart);
		this._addToParent(new Comment(value, sourceSpan));
	}
	_consumeDocType(startToken) {
		const text = this._advanceIf(TokenType.RAW_TEXT);
		const endToken = this._advanceIf(TokenType.DOC_TYPE_END);
		const value = text != null ? text.parts[0].trim() : null;
		const sourceSpan = new ParseSourceSpan(startToken.sourceSpan.start, (endToken || text || startToken).sourceSpan.end);
		this._addToParent(new DocType(value, sourceSpan));
	}
	_consumeExpansion(token) {
		const switchValue = this._advance();
		const type = this._advance();
		const cases = [];
		while (this._peek.type === TokenType.EXPANSION_CASE_VALUE) {
			const expCase = this._parseExpansionCase();
			if (!expCase) return;
			cases.push(expCase);
		}
		if (this._peek.type !== TokenType.EXPANSION_FORM_END) {
			this.errors.push(TreeError.create(null, this._peek.sourceSpan, `Invalid ICU message. Missing '}'.`));
			return;
		}
		const sourceSpan = new ParseSourceSpan(token.sourceSpan.start, this._peek.sourceSpan.end, token.sourceSpan.fullStart);
		this._addToParent(new Expansion(switchValue.parts[0], type.parts[0], cases, sourceSpan, switchValue.sourceSpan));
		this._advance();
	}
	_parseExpansionCase() {
		const value = this._advance();
		if (this._peek.type !== TokenType.EXPANSION_CASE_EXP_START) {
			this.errors.push(TreeError.create(null, this._peek.sourceSpan, `Invalid ICU message. Missing '{'.`));
			return null;
		}
		const start = this._advance();
		const exp = this._collectExpansionExpTokens(start);
		if (!exp) return null;
		const end = this._advance();
		exp.push({
			type: TokenType.EOF,
			parts: [],
			sourceSpan: end.sourceSpan
		});
		const expansionCaseParser = new _TreeBuilder(exp, this.tagDefinitionResolver, this.canSelfClose, this.allowHtmComponentClosingTags, this.isTagNameCaseSensitive);
		expansionCaseParser.build();
		if (expansionCaseParser.errors.length > 0) {
			this.errors = this.errors.concat(expansionCaseParser.errors);
			return null;
		}
		const sourceSpan = new ParseSourceSpan(value.sourceSpan.start, end.sourceSpan.end, value.sourceSpan.fullStart);
		const expSourceSpan = new ParseSourceSpan(start.sourceSpan.start, end.sourceSpan.end, start.sourceSpan.fullStart);
		return new ExpansionCase(value.parts[0], expansionCaseParser.rootNodes, sourceSpan, value.sourceSpan, expSourceSpan);
	}
	_collectExpansionExpTokens(start) {
		const exp = [];
		const expansionFormStack = [TokenType.EXPANSION_CASE_EXP_START];
		while (true) {
			if (this._peek.type === TokenType.EXPANSION_FORM_START || this._peek.type === TokenType.EXPANSION_CASE_EXP_START) expansionFormStack.push(this._peek.type);
			if (this._peek.type === TokenType.EXPANSION_CASE_EXP_END) if (lastOnStack(expansionFormStack, TokenType.EXPANSION_CASE_EXP_START)) {
				expansionFormStack.pop();
				if (expansionFormStack.length === 0) return exp;
			} else {
				this.errors.push(TreeError.create(null, start.sourceSpan, `Invalid ICU message. Missing '}'.`));
				return null;
			}
			if (this._peek.type === TokenType.EXPANSION_FORM_END) if (lastOnStack(expansionFormStack, TokenType.EXPANSION_FORM_START)) expansionFormStack.pop();
			else {
				this.errors.push(TreeError.create(null, start.sourceSpan, `Invalid ICU message. Missing '}'.`));
				return null;
			}
			if (this._peek.type === TokenType.EOF) {
				this.errors.push(TreeError.create(null, start.sourceSpan, `Invalid ICU message. Missing '}'.`));
				return null;
			}
			exp.push(this._advance());
		}
	}
	_getText(token) {
		let text = token.parts[0];
		if (text.length > 0 && text[0] == "\n") {
			var _this$_getTagDefiniti;
			const parent = this._getClosestElementLikeParent();
			if (parent != null && parent.children.length == 0 && ((_this$_getTagDefiniti = this._getTagDefinition(parent)) === null || _this$_getTagDefiniti === void 0 ? void 0 : _this$_getTagDefiniti.ignoreFirstLf)) text = text.substring(1);
		}
		return text;
	}
	_consumeText(token) {
		const tokens = [token];
		const startSpan = token.sourceSpan;
		let text = token.parts[0];
		if (text.length > 0 && text[0] === "\n") {
			var _this$_getTagDefiniti2;
			const parent = this._getContainer();
			if (parent != null && parent.children.length === 0 && ((_this$_getTagDefiniti2 = this._getTagDefinition(parent)) === null || _this$_getTagDefiniti2 === void 0 ? void 0 : _this$_getTagDefiniti2.ignoreFirstLf)) {
				text = text.substring(1);
				tokens[0] = {
					type: token.type,
					sourceSpan: token.sourceSpan,
					parts: [text]
				};
			}
		}
		while (this._peek.type === TokenType.INTERPOLATION || this._peek.type === TokenType.TEXT || this._peek.type === TokenType.ENCODED_ENTITY) {
			token = this._advance();
			tokens.push(token);
			if (token.type === TokenType.INTERPOLATION) text += token.parts.join("").replace(/&([^;]+);/g, decodeEntity);
			else if (token.type === TokenType.ENCODED_ENTITY) text += token.parts[0];
			else text += token.parts.join("");
		}
		if (text.length > 0) {
			const endSpan = token.sourceSpan;
			this._addToParent(new Text(text, new ParseSourceSpan(startSpan.start, endSpan.end, startSpan.fullStart, startSpan.details), tokens));
		}
	}
	_closeVoidElement() {
		var _this$_getTagDefiniti3;
		const el = this._getContainer();
		if (el !== null && ((_this$_getTagDefiniti3 = this._getTagDefinition(el)) === null || _this$_getTagDefiniti3 === void 0 ? void 0 : _this$_getTagDefiniti3.isVoid)) this._containerStack.pop();
	}
	_consumeElementStartTag(startTagToken) {
		var _this$_getTagDefiniti4;
		const attrs = [];
		const directives = [];
		this._consumeAttributesAndDirectives(attrs, directives);
		const fullName = this._getElementFullName(startTagToken, this._getClosestElementLikeParent());
		const tagDef = this._getTagDefinition(fullName);
		let selfClosing = false;
		if (this._peek.type === TokenType.TAG_OPEN_END_VOID) {
			this._advance();
			selfClosing = true;
			const tagDef$1 = this._getTagDefinition(fullName);
			if (!(this.canSelfClose || (tagDef$1 === null || tagDef$1 === void 0 ? void 0 : tagDef$1.canSelfClose) || getNsPrefix(fullName) !== null || (tagDef$1 === null || tagDef$1 === void 0 ? void 0 : tagDef$1.isVoid))) this.errors.push(TreeError.create(fullName, startTagToken.sourceSpan, `Only void, custom and foreign elements can be self closed "${startTagToken.parts[1]}"`));
		} else if (this._peek.type === TokenType.TAG_OPEN_END) {
			this._advance();
			selfClosing = false;
		}
		const end = this._peek.sourceSpan.fullStart;
		const span = new ParseSourceSpan(startTagToken.sourceSpan.start, end, startTagToken.sourceSpan.fullStart);
		const startSpan = new ParseSourceSpan(startTagToken.sourceSpan.start, end, startTagToken.sourceSpan.fullStart);
		const nameSpan = new ParseSourceSpan(startTagToken.sourceSpan.start.moveBy(1), startTagToken.sourceSpan.end);
		const el = new Element(fullName, attrs, directives, [], selfClosing, span, startSpan, void 0, nameSpan, (tagDef === null || tagDef === void 0 ? void 0 : tagDef.isVoid) ?? false);
		const parent = this._getContainer();
		const isClosedByChild = parent !== null && !!((_this$_getTagDefiniti4 = this._getTagDefinition(parent)) === null || _this$_getTagDefiniti4 === void 0 ? void 0 : _this$_getTagDefiniti4.isClosedByChild(el.name));
		this._pushContainer(el, isClosedByChild);
		if (selfClosing) this._popContainer(fullName, Element, span);
		else if (startTagToken.type === TokenType.INCOMPLETE_TAG_OPEN) {
			this._popContainer(fullName, Element, null);
			this.errors.push(TreeError.create(fullName, span, `Opening tag "${fullName}" not terminated.`));
		}
	}
	_consumeComponentStartTag(startToken) {
		var _this$_getTagDefiniti5;
		const componentName = startToken.parts[0];
		const attrs = [];
		const directives = [];
		this._consumeAttributesAndDirectives(attrs, directives);
		const closestElement = this._getClosestElementLikeParent();
		const tagName = this._getComponentTagName(startToken, closestElement);
		const fullName = this._getComponentFullName(startToken, closestElement);
		const selfClosing = this._peek.type === TokenType.COMPONENT_OPEN_END_VOID;
		this._advance();
		const end = this._peek.sourceSpan.fullStart;
		const span = new ParseSourceSpan(startToken.sourceSpan.start, end, startToken.sourceSpan.fullStart);
		const startSpan = new ParseSourceSpan(startToken.sourceSpan.start, end, startToken.sourceSpan.fullStart);
		const node = new Component(componentName, tagName, fullName, attrs, directives, [], selfClosing, span, startSpan, void 0);
		const parent = this._getContainer();
		const isClosedByChild = parent !== null && node.tagName !== null && !!((_this$_getTagDefiniti5 = this._getTagDefinition(parent)) === null || _this$_getTagDefiniti5 === void 0 ? void 0 : _this$_getTagDefiniti5.isClosedByChild(node.tagName));
		this._pushContainer(node, isClosedByChild);
		if (selfClosing) this._popContainer(fullName, Component, span);
		else if (startToken.type === TokenType.INCOMPLETE_COMPONENT_OPEN) {
			this._popContainer(fullName, Component, null);
			this.errors.push(TreeError.create(fullName, span, `Opening tag "${fullName}" not terminated.`));
		}
	}
	_consumeAttributesAndDirectives(attributesResult, directivesResult) {
		while (this._peek.type === TokenType.ATTR_NAME || this._peek.type === TokenType.DIRECTIVE_NAME) if (this._peek.type === TokenType.DIRECTIVE_NAME) directivesResult.push(this._consumeDirective(this._peek));
		else attributesResult.push(this._consumeAttr(this._advance()));
	}
	_consumeComponentEndTag(endToken) {
		const fullName = this._getComponentFullName(endToken, this._getClosestElementLikeParent());
		if (!this._popContainer(fullName, Component, endToken.sourceSpan)) {
			const container = this._containerStack[this._containerStack.length - 1];
			let suffix;
			if (container instanceof Component && container.componentName === endToken.parts[0]) suffix = `, did you mean "${container.fullName}"?`;
			else suffix = ". It may happen when the tag has already been closed by another tag.";
			const errMsg = `Unexpected closing tag "${fullName}"${suffix}`;
			this.errors.push(TreeError.create(fullName, endToken.sourceSpan, errMsg));
		}
	}
	_getTagDefinition(nodeOrName) {
		if (typeof nodeOrName === "string") return this.tagDefinitionResolver(nodeOrName);
		else if (nodeOrName instanceof Element) return this.tagDefinitionResolver(nodeOrName.name);
		else if (nodeOrName instanceof Component && nodeOrName.tagName !== null) return this.tagDefinitionResolver(nodeOrName.tagName);
		else return null;
	}
	_pushContainer(node, isClosedByChild) {
		if (isClosedByChild) this._containerStack.pop();
		this._addToParent(node);
		this._containerStack.push(node);
	}
	_consumeElementEndTag(endTagToken) {
		var _this$_getTagDefiniti6;
		const fullName = this.allowHtmComponentClosingTags && endTagToken.parts.length === 0 ? null : this._getElementFullName(endTagToken, this._getClosestElementLikeParent());
		if (fullName && ((_this$_getTagDefiniti6 = this._getTagDefinition(fullName)) === null || _this$_getTagDefiniti6 === void 0 ? void 0 : _this$_getTagDefiniti6.isVoid)) this.errors.push(TreeError.create(fullName, endTagToken.sourceSpan, `Void elements do not have end tags "${endTagToken.parts[1]}"`));
		else if (!this._popContainer(fullName, Element, endTagToken.sourceSpan)) {
			const errMsg = `Unexpected closing tag "${fullName}". It may happen when the tag has already been closed by another tag. For more info see https://www.w3.org/TR/html5/syntax.html#closing-elements-that-have-implied-end-tags`;
			this.errors.push(TreeError.create(fullName, endTagToken.sourceSpan, errMsg));
		}
	}
	/**
	* Closes the nearest element with the tag name `fullName` in the parse tree.
	* `endSourceSpan` is the span of the closing tag, or null if the element does
	* not have a closing tag (for example, this happens when an incomplete
	* opening tag is recovered).
	*/
	_popContainer(expectedName, expectedType, endSourceSpan) {
		let unexpectedCloseTagDetected = false;
		for (let stackIndex = this._containerStack.length - 1; stackIndex >= 0; stackIndex--) {
			var _this$_getTagDefiniti7;
			const node = this._containerStack[stackIndex];
			const nodeName = node instanceof Component ? node.fullName : node.name;
			if (getNsPrefix(nodeName) ? nodeName === expectedName : (nodeName === expectedName || expectedName === null) && node instanceof expectedType) {
				node.endSourceSpan = endSourceSpan;
				node.sourceSpan.end = endSourceSpan !== null ? endSourceSpan.end : node.sourceSpan.end;
				this._containerStack.splice(stackIndex, this._containerStack.length - stackIndex);
				return !unexpectedCloseTagDetected;
			}
			if (node instanceof Block || !((_this$_getTagDefiniti7 = this._getTagDefinition(node)) === null || _this$_getTagDefiniti7 === void 0 ? void 0 : _this$_getTagDefiniti7.closedByParent)) unexpectedCloseTagDetected = true;
		}
		return false;
	}
	_consumeAttr(attrName) {
		const fullName = mergeNsAndName(attrName.parts[0], attrName.parts[1]);
		let attrEnd = attrName.sourceSpan.end;
		let startQuoteToken;
		if (this._peek.type === TokenType.ATTR_QUOTE) startQuoteToken = this._advance();
		let value = "";
		const valueTokens = [];
		let valueStartSpan = void 0;
		let valueEnd = void 0;
		if (this._peek.type === TokenType.ATTR_VALUE_TEXT) {
			valueStartSpan = this._peek.sourceSpan;
			valueEnd = this._peek.sourceSpan.end;
			while (this._peek.type === TokenType.ATTR_VALUE_TEXT || this._peek.type === TokenType.ATTR_VALUE_INTERPOLATION || this._peek.type === TokenType.ENCODED_ENTITY) {
				const valueToken = this._advance();
				valueTokens.push(valueToken);
				if (valueToken.type === TokenType.ATTR_VALUE_INTERPOLATION) value += valueToken.parts.join("").replace(/&([^;]+);/g, decodeEntity);
				else if (valueToken.type === TokenType.ENCODED_ENTITY) value += valueToken.parts[0];
				else value += valueToken.parts.join("");
				valueEnd = attrEnd = valueToken.sourceSpan.end;
			}
		}
		if (this._peek.type === TokenType.ATTR_QUOTE) valueEnd = attrEnd = this._advance().sourceSpan.end;
		const valueSpan = valueStartSpan && valueEnd && new ParseSourceSpan((startQuoteToken === null || startQuoteToken === void 0 ? void 0 : startQuoteToken.sourceSpan.start) ?? valueStartSpan.start, valueEnd, (startQuoteToken === null || startQuoteToken === void 0 ? void 0 : startQuoteToken.sourceSpan.fullStart) ?? valueStartSpan.fullStart);
		return new Attribute(fullName, value, new ParseSourceSpan(attrName.sourceSpan.start, attrEnd, attrName.sourceSpan.fullStart), attrName.sourceSpan, valueSpan, valueTokens.length > 0 ? valueTokens : void 0, void 0);
	}
	_consumeDirective(nameToken) {
		const attributes = [];
		let startSourceSpanEnd = nameToken.sourceSpan.end;
		let endSourceSpan = null;
		this._advance();
		if (this._peek.type === TokenType.DIRECTIVE_OPEN) {
			startSourceSpanEnd = this._peek.sourceSpan.end;
			this._advance();
			while (this._peek.type === TokenType.ATTR_NAME) attributes.push(this._consumeAttr(this._advance()));
			if (this._peek.type === TokenType.DIRECTIVE_CLOSE) {
				endSourceSpan = this._peek.sourceSpan;
				this._advance();
			} else this.errors.push(TreeError.create(null, nameToken.sourceSpan, "Unterminated directive definition"));
		}
		const startSourceSpan = new ParseSourceSpan(nameToken.sourceSpan.start, startSourceSpanEnd, nameToken.sourceSpan.fullStart);
		const sourceSpan = new ParseSourceSpan(startSourceSpan.start, endSourceSpan === null ? nameToken.sourceSpan.end : endSourceSpan.end, startSourceSpan.fullStart);
		return new Directive(nameToken.parts[0], attributes, sourceSpan, startSourceSpan, endSourceSpan);
	}
	_consumeBlockOpen(token) {
		const parameters = [];
		while (this._peek.type === TokenType.BLOCK_PARAMETER) {
			const paramToken = this._advance();
			parameters.push(new BlockParameter(paramToken.parts[0], paramToken.sourceSpan));
		}
		if (this._peek.type === TokenType.BLOCK_OPEN_END) this._advance();
		const end = this._peek.sourceSpan.fullStart;
		const span = new ParseSourceSpan(token.sourceSpan.start, end, token.sourceSpan.fullStart);
		const startSpan = new ParseSourceSpan(token.sourceSpan.start, end, token.sourceSpan.fullStart);
		const block = new Block(token.parts[0], parameters, [], span, token.sourceSpan, startSpan);
		this._pushContainer(block, false);
	}
	_consumeBlockClose(token) {
		if (!this._popContainer(null, Block, token.sourceSpan)) this.errors.push(TreeError.create(null, token.sourceSpan, "Unexpected closing block. The block may have been closed earlier. If you meant to write the } character, you should use the \"&#125;\" HTML entity instead."));
	}
	_consumeIncompleteBlock(token) {
		const parameters = [];
		while (this._peek.type === TokenType.BLOCK_PARAMETER) {
			const paramToken = this._advance();
			parameters.push(new BlockParameter(paramToken.parts[0], paramToken.sourceSpan));
		}
		const end = this._peek.sourceSpan.fullStart;
		const span = new ParseSourceSpan(token.sourceSpan.start, end, token.sourceSpan.fullStart);
		const startSpan = new ParseSourceSpan(token.sourceSpan.start, end, token.sourceSpan.fullStart);
		const block = new Block(token.parts[0], parameters, [], span, token.sourceSpan, startSpan);
		this._pushContainer(block, false);
		this._popContainer(null, Block, null);
		this.errors.push(TreeError.create(token.parts[0], span, `Incomplete block "${token.parts[0]}". If you meant to write the @ character, you should use the "&#64;" HTML entity instead.`));
	}
	_consumeLet(startToken) {
		const name = startToken.parts[0];
		let valueToken;
		let endToken;
		if (this._peek.type !== TokenType.LET_VALUE) {
			this.errors.push(TreeError.create(startToken.parts[0], startToken.sourceSpan, `Invalid @let declaration "${name}". Declaration must have a value.`));
			return;
		} else valueToken = this._advance();
		if (this._peek.type !== TokenType.LET_END) {
			this.errors.push(TreeError.create(startToken.parts[0], startToken.sourceSpan, `Unterminated @let declaration "${name}". Declaration must be terminated with a semicolon.`));
			return;
		} else endToken = this._advance();
		const end = endToken.sourceSpan.fullStart;
		const span = new ParseSourceSpan(startToken.sourceSpan.start, end, startToken.sourceSpan.fullStart);
		const startOffset = startToken.sourceSpan.toString().lastIndexOf(name);
		const nameSpan = new ParseSourceSpan(startToken.sourceSpan.start.moveBy(startOffset), startToken.sourceSpan.end);
		const node = new LetDeclaration(name, valueToken.parts[0], span, nameSpan, valueToken.sourceSpan);
		this._addToParent(node);
	}
	_consumeIncompleteLet(token) {
		const name = token.parts[0] ?? "";
		const nameString = name ? ` "${name}"` : "";
		if (name.length > 0) {
			const startOffset = token.sourceSpan.toString().lastIndexOf(name);
			const nameSpan = new ParseSourceSpan(token.sourceSpan.start.moveBy(startOffset), token.sourceSpan.end);
			const valueSpan = new ParseSourceSpan(token.sourceSpan.start, token.sourceSpan.start.moveBy(0));
			const node = new LetDeclaration(name, "", token.sourceSpan, nameSpan, valueSpan);
			this._addToParent(node);
		}
		this.errors.push(TreeError.create(token.parts[0], token.sourceSpan, `Incomplete @let declaration${nameString}. @let declarations must be written as \`@let <name> = <value>;\``));
	}
	_getContainer() {
		return this._containerStack.length > 0 ? this._containerStack[this._containerStack.length - 1] : null;
	}
	_getClosestElementLikeParent() {
		for (let i = this._containerStack.length - 1; i > -1; i--) {
			const current = this._containerStack[i];
			if (current instanceof Element || current instanceof Component) return current;
		}
		return null;
	}
	_addToParent(node) {
		const parent = this._getContainer();
		if (parent === null) this.rootNodes.push(node);
		else parent.children.push(node);
	}
	_getElementFullName(token, parent) {
		return mergeNsAndName(this._getPrefix(token, parent), token.parts[1]);
	}
	_getComponentFullName(token, parent) {
		const componentName = token.parts[0];
		const tagName = this._getComponentTagName(token, parent);
		if (tagName === null) return componentName;
		return tagName.startsWith(":") ? componentName + tagName : `${componentName}:${tagName}`;
	}
	_getComponentTagName(token, parent) {
		const prefix = this._getPrefix(token, parent);
		const tagName = token.parts[2];
		if (!prefix && !tagName) return null;
		else if (!prefix && tagName) return tagName;
		else return mergeNsAndName(prefix, tagName || "ng-component");
	}
	_getPrefix(token, parent) {
		var _this$_getTagDefiniti8;
		let prefix;
		let tagName;
		if (token.type === TokenType.COMPONENT_OPEN_START || token.type === TokenType.INCOMPLETE_COMPONENT_OPEN || token.type === TokenType.COMPONENT_CLOSE) {
			prefix = token.parts[1];
			tagName = token.parts[2];
		} else {
			prefix = token.parts[0];
			tagName = token.parts[1];
		}
		prefix = prefix || ((_this$_getTagDefiniti8 = this._getTagDefinition(tagName)) === null || _this$_getTagDefiniti8 === void 0 ? void 0 : _this$_getTagDefiniti8.implicitNamespacePrefix) || "";
		if (!prefix && parent) {
			const parentName = parent instanceof Element ? parent.name : parent.tagName;
			if (parentName !== null) {
				const parentTagName = splitNsName(parentName)[1];
				const parentTagDefinition = this._getTagDefinition(parentTagName);
				if (parentTagDefinition !== null && !parentTagDefinition.preventNamespaceInheritance) prefix = getNsPrefix(parentName);
			}
		}
		return prefix;
	}
};
function lastOnStack(stack, element) {
	return stack.length > 0 && stack[stack.length - 1] === element;
}
/**
* Decode the `entity` string, which we believe is the contents of an HTML entity.
*
* If the string is not actually a valid/known entity then just return the original `match` string.
*/
function decodeEntity(match, entity) {
	if (NAMED_ENTITIES[entity] !== void 0) return NAMED_ENTITIES[entity] || match;
	if (/^#x[a-f0-9]+$/i.test(entity)) return String.fromCodePoint(parseInt(entity.slice(2), 16));
	if (/^#\d+$/.test(entity)) return String.fromCodePoint(parseInt(entity.slice(1), 10));
	return match;
}

//#endregion
export { Parser };