export function groupBy(arr, criteria) {
    // @ts-expect-error -- groupBy exists in Node 22+
    if (Object.groupBy) {
        // @ts-expect-error -- groupBy exists in Node 22+
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return
        return Object.groupBy(arr, criteria);
    }
    return arr.reduce((acc, item) => {
        const key = criteria(item);
        acc[key] ??= [];
        acc[key].push(item);
        return acc;
    }, Object.create(null));
}
//# sourceMappingURL=group-by.js.map