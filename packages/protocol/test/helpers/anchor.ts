/// The root to prove against and the tree it belongs to, as one read.
///
/// Read as one call rather than assembled from `getLastRoot()` and a hardcoded
/// `treeNumber: [0, 0]`. That pairing is correct only until the pool rolls over, and it is
/// exactly the pairing the contract refuses to expose.
export async function anchorOf(pool: any): Promise<{ root: string; tree: number }> {
  const [root, tree] = await pool.currentAnchor();
  return { root, tree: Number(tree) };
}
