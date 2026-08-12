/// The root to prove against and the tree it belongs to, as one read.
///
/// Tests used to pair `getLastRoot()` with a hardcoded `treeNumber: [0, 0]`, which is correct
/// only until the pool rolls over — exactly the pairing the contract refuses to expose.
export async function anchorOf(pool: any): Promise<{ root: string; tree: number }> {
  const [root, tree] = await pool.currentAnchor();
  return { root, tree: Number(tree) };
}
