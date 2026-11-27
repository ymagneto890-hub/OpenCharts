/**
 * DOM Mutation & Google/Edge Translate Protection
 *
 * When browsers (e.g. Chrome/Edge automatic page translation or extensions)
 * wrap or reparent DOM text nodes into <font> elements, React's reconciler
 * fails on unmount with: "Failed to execute 'removeChild' on 'Node':
 * The node to be removed is not a child of this node."
 *
 * Intercepting removeChild and insertBefore prevents these fatal crashes
 * and allows React components to mount, unmount, and update smoothly.
 */
export function applyDomReconciliationPatch(): void {
  if (typeof Node === "function" && Node.prototype) {
    const proto = Node.prototype as unknown as {
      __domPatchApplied?: boolean;
      removeChild: <T extends Node>(child: T) => T;
      insertBefore: <T extends Node>(newNode: T, referenceNode: Node | null) => T;
    };

    if (proto.__domPatchApplied) return;
    proto.__domPatchApplied = true;

    const originalRemoveChild = proto.removeChild;
    proto.removeChild = function <T extends Node>(child: T): T {
      if (!child) return child;
      if (child.parentNode !== this) {
        if (child.parentNode) {
          try {
            return child.parentNode.removeChild(child) as T;
          } catch {
            return child;
          }
        }
        return child;
      }
      return originalRemoveChild.call(this, child) as T;
    };

    const originalInsertBefore = proto.insertBefore;
    proto.insertBefore = function <T extends Node>(newNode: T, referenceNode: Node | null): T {
      if (!newNode) return newNode;
      if (referenceNode && referenceNode.parentNode !== this) {
        if (referenceNode.parentNode) {
          try {
            return referenceNode.parentNode.insertBefore(newNode, referenceNode) as T;
          } catch {
            return newNode;
          }
        }
        return newNode;
      }
      return originalInsertBefore.call(this, newNode, referenceNode) as T;
    };
  }
}

// Auto-apply on import
applyDomReconciliationPatch();
