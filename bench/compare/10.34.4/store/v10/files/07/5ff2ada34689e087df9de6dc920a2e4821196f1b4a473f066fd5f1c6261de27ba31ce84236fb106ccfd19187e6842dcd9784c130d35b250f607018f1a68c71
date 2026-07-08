import { Parser } from "./parser.mjs";
import { getXmlTagDefinition } from "./xml_tags.mjs";

//#region ../compiler/src/ml_parser/xml_parser.ts
var XmlParser = class extends Parser {
	constructor() {
		super(getXmlTagDefinition);
	}
	parse(source, url, options = {}) {
		return super.parse(source, url, {
			...options,
			tokenizeBlocks: false,
			tokenizeLet: false,
			selectorlessEnabled: false
		});
	}
};

//#endregion
export { XmlParser };