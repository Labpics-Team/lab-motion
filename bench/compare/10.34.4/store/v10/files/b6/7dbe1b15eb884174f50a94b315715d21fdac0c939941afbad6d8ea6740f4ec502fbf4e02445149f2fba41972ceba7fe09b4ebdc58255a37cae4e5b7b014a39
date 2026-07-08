//#region ../compiler/src/ml_parser/ast.ts
var NodeWithI18n = class {
	constructor(sourceSpan, i18n) {
		this.sourceSpan = sourceSpan;
		this.i18n = i18n;
	}
};
var Text = class extends NodeWithI18n {
	constructor(value, sourceSpan, tokens, i18n) {
		super(sourceSpan, i18n);
		this.value = value;
		this.tokens = tokens;
	}
	visit(visitor, context) {
		return visitor.visitText(this, context);
	}
	kind = "text";
};
var CDATA = class extends NodeWithI18n {
	constructor(value, sourceSpan, tokens, i18n) {
		super(sourceSpan, i18n);
		this.value = value;
		this.tokens = tokens;
	}
	visit(visitor, context) {
		return visitor.visitCdata(this, context);
	}
	kind = "cdata";
};
var Expansion = class extends NodeWithI18n {
	constructor(switchValue, type, cases, sourceSpan, switchValueSourceSpan, i18n) {
		super(sourceSpan, i18n);
		this.switchValue = switchValue;
		this.type = type;
		this.cases = cases;
		this.switchValueSourceSpan = switchValueSourceSpan;
	}
	visit(visitor, context) {
		return visitor.visitExpansion(this, context);
	}
	kind = "expansion";
};
var ExpansionCase = class {
	constructor(value, expression, sourceSpan, valueSourceSpan, expSourceSpan) {
		this.value = value;
		this.expression = expression;
		this.sourceSpan = sourceSpan;
		this.valueSourceSpan = valueSourceSpan;
		this.expSourceSpan = expSourceSpan;
	}
	visit(visitor, context) {
		return visitor.visitExpansionCase(this, context);
	}
	kind = "expansionCase";
};
var Attribute = class extends NodeWithI18n {
	constructor(name, value, sourceSpan, keySpan, valueSpan, valueTokens, i18n) {
		super(sourceSpan, i18n);
		this.name = name;
		this.value = value;
		this.keySpan = keySpan;
		this.valueSpan = valueSpan;
		this.valueTokens = valueTokens;
	}
	visit(visitor, context) {
		return visitor.visitAttribute(this, context);
	}
	kind = "attribute";
	get nameSpan() {
		return this.keySpan;
	}
};
var Element = class extends NodeWithI18n {
	constructor(name, attrs, directives, children, isSelfClosing, sourceSpan, startSourceSpan, endSourceSpan = null, nameSpan = null, isVoid, i18n) {
		super(sourceSpan, i18n);
		this.name = name;
		this.attrs = attrs;
		this.directives = directives;
		this.children = children;
		this.isSelfClosing = isSelfClosing;
		this.startSourceSpan = startSourceSpan;
		this.endSourceSpan = endSourceSpan;
		this.nameSpan = nameSpan;
		this.isVoid = isVoid;
	}
	visit(visitor, context) {
		return visitor.visitElement(this, context);
	}
	kind = "element";
};
var Comment = class {
	constructor(value, sourceSpan) {
		this.value = value;
		this.sourceSpan = sourceSpan;
	}
	visit(visitor, context) {
		return visitor.visitComment(this, context);
	}
	kind = "comment";
};
var DocType = class {
	constructor(value, sourceSpan) {
		this.value = value;
		this.sourceSpan = sourceSpan;
	}
	visit(visitor, context) {
		return visitor.visitDocType(this, context);
	}
	kind = "docType";
};
var Block = class extends NodeWithI18n {
	constructor(name, parameters, children, sourceSpan, nameSpan, startSourceSpan, endSourceSpan = null, i18n) {
		super(sourceSpan, i18n);
		this.name = name;
		this.parameters = parameters;
		this.children = children;
		this.nameSpan = nameSpan;
		this.startSourceSpan = startSourceSpan;
		this.endSourceSpan = endSourceSpan;
	}
	visit(visitor, context) {
		return visitor.visitBlock(this, context);
	}
	kind = "block";
};
var Component = class extends NodeWithI18n {
	constructor(componentName, tagName, fullName, attrs, directives, children, isSelfClosing, sourceSpan, startSourceSpan, endSourceSpan = null, i18n) {
		super(sourceSpan, i18n);
		this.componentName = componentName;
		this.tagName = tagName;
		this.fullName = fullName;
		this.attrs = attrs;
		this.directives = directives;
		this.children = children;
		this.isSelfClosing = isSelfClosing;
		this.startSourceSpan = startSourceSpan;
		this.endSourceSpan = endSourceSpan;
	}
	visit(visitor, context) {
		return visitor.visitComponent(this, context);
	}
	kind = "component";
};
var Directive = class {
	constructor(name, attrs, sourceSpan, startSourceSpan, endSourceSpan = null) {
		this.name = name;
		this.attrs = attrs;
		this.sourceSpan = sourceSpan;
		this.startSourceSpan = startSourceSpan;
		this.endSourceSpan = endSourceSpan;
	}
	visit(visitor, context) {
		return visitor.visitDirective(this, context);
	}
	kind = "directive";
};
var BlockParameter = class {
	constructor(expression, sourceSpan) {
		this.expression = expression;
		this.sourceSpan = sourceSpan;
	}
	visit(visitor, context) {
		return visitor.visitBlockParameter(this, context);
	}
	kind = "blockParameter";
	startSourceSpan = null;
	endSourceSpan = null;
};
var LetDeclaration = class {
	constructor(name, value, sourceSpan, nameSpan, valueSpan) {
		this.name = name;
		this.value = value;
		this.sourceSpan = sourceSpan;
		this.nameSpan = nameSpan;
		this.valueSpan = valueSpan;
	}
	visit(visitor, context) {
		return visitor.visitLetDeclaration(this, context);
	}
	kind = "letDeclaration";
	startSourceSpan = null;
	endSourceSpan = null;
};
function visitAll(visitor, nodes, context = null) {
	const result = [];
	const visit = visitor.visit ? (ast) => visitor.visit(ast, context) || ast.visit(visitor, context) : (ast) => ast.visit(visitor, context);
	nodes.forEach((ast) => {
		const astResult = visit(ast);
		if (astResult) result.push(astResult);
	});
	return result;
}
var RecursiveVisitor = class {
	constructor() {}
	visitElement(ast, context) {
		this.visitChildren(context, (visit) => {
			visit(ast.attrs);
			visit(ast.directives);
			visit(ast.children);
		});
	}
	visitAttribute(ast, context) {}
	visitText(ast, context) {}
	visitCdata(ast, context) {}
	visitComment(ast, context) {}
	visitDocType(ast, context) {}
	visitExpansion(ast, context) {
		return this.visitChildren(context, (visit) => {
			visit(ast.cases);
		});
	}
	visitExpansionCase(ast, context) {}
	visitBlock(block, context) {
		this.visitChildren(context, (visit) => {
			visit(block.parameters);
			visit(block.children);
		});
	}
	visitBlockParameter(ast, context) {}
	visitLetDeclaration(decl, context) {}
	visitComponent(component, context) {
		this.visitChildren(context, (visit) => {
			visit(component.attrs);
			visit(component.children);
		});
	}
	visitDirective(directive, context) {
		this.visitChildren(context, (visit) => {
			visit(directive.attrs);
		});
	}
	visitChildren(context, cb) {
		let results = [];
		let t = this;
		function visit(children) {
			if (children) results.push(visitAll(t, children, context));
		}
		cb(visit);
		return Array.prototype.concat.apply([], results);
	}
};

//#endregion
export { Attribute, Block, BlockParameter, CDATA, Comment, Component, Directive, DocType, Element, Expansion, ExpansionCase, LetDeclaration, RecursiveVisitor, Text, visitAll };