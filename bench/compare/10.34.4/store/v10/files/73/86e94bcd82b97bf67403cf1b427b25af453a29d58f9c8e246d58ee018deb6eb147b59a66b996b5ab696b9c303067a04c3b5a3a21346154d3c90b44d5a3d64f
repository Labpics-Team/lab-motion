//#region ../compiler/src/ml_parser/tags.d.ts
/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */
declare enum TagContentType {
  RAW_TEXT = 0,
  ESCAPABLE_RAW_TEXT = 1,
  PARSABLE_DATA = 2,
}
interface TagDefinition {
  closedByParent: boolean;
  implicitNamespacePrefix: string | null;
  isVoid: boolean;
  ignoreFirstLf: boolean;
  canSelfClose: boolean;
  preventNamespaceInheritance: boolean;
  isClosedByChild(name: string): boolean;
  getContentType(prefix?: string): TagContentType;
}
//#endregion
export { TagContentType, TagDefinition };