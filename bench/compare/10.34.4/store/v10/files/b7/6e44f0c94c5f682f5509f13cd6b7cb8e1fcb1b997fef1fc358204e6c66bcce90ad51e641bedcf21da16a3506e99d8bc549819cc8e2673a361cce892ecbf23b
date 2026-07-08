export class MultiPreprocessor {
    preprocessors;
    constructor(preprocessors) {
        this.preprocessors = preprocessors;
    }
    async preprocess(project) {
        for (const preprocessor of this.preprocessors) {
            await preprocessor.preprocess(project);
        }
    }
}
//# sourceMappingURL=multi-preprocessor.js.map