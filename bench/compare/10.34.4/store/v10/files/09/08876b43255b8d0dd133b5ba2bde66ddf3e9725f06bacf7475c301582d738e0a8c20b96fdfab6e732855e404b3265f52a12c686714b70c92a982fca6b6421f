import { TagContentType } from "./compiler/src/ml_parser/tags.mjs";
import { getHtmlTagDefinition } from "./compiler/src/ml_parser/html_tags.mjs";
import { ParseLocation, ParseSourceFile, ParseSourceSpan } from "./compiler/src/parse_util.mjs";
import { RecursiveVisitor, visitAll } from "./compiler/src/ml_parser/ast.mjs";
import { HtmlParser } from "./compiler/src/ml_parser/html_parser.mjs";
import { XmlParser } from "./compiler/src/ml_parser/xml_parser.mjs";

//#region src/index.ts
let htmlParser;
function parseHtml(input, options = {}) {
	const { canSelfClose = false, allowHtmComponentClosingTags = false, isTagNameCaseSensitive = false, getTagContentType, tokenizeAngularBlocks = false, tokenizeAngularLetDeclaration = false, enableAngularSelectorlessSyntax = false } = options;
	htmlParser ?? (htmlParser = new HtmlParser());
	return htmlParser.parse(input, "angular-html-parser", {
		tokenizeExpansionForms: tokenizeAngularBlocks,
		canSelfClose,
		allowHtmComponentClosingTags,
		tokenizeBlocks: tokenizeAngularBlocks,
		tokenizeLet: tokenizeAngularLetDeclaration,
		selectorlessEnabled: enableAngularSelectorlessSyntax
	}, isTagNameCaseSensitive, getTagContentType);
}
let xmlParser;
function parseXml(input) {
	xmlParser ?? (xmlParser = new XmlParser());
	return xmlParser.parse(input, "angular-xml-parser");
}

//#endregion
export { ParseLocation, ParseSourceFile, ParseSourceSpan, RecursiveVisitor, TagContentType, getHtmlTagDefinition, parseHtml as parse, parseHtml, parseXml, visitAll };