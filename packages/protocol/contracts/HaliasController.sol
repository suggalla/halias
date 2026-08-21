// SPDX-License-Identifier: GPL-3.0
// Copyright 2026 Halias contributors.
pragma solidity 0.8.28;

import { HaliasRegistry } from "./HaliasRegistry.sol";
import { IHaliasPool, TransactParams } from "./interfaces/IHaliasPool.sol";
import { ERC721 } from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { Address } from "@openzeppelin/contracts/utils/Address.sol";
import { EIP712 } from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import { SignatureChecker } from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

// ── Custom errors ─────────────────────────────────────────────────────────────

error ZeroDependency();
error NotAdmin();
error NotPendingAdmin();
error NotAliasOwner();
error InvalidOwner();
error WrongRegistrationFee();
error NoPrepaidClaim();
error NotAnInviteEntry();
error InviteMustNotPayOut();
error ClaimMustPayNothing(uint256 received);
error NoReservation();
error ReservationTooNew();
error ReservationExpired();
error ReservationPending();
error NameDoesNotMatchAlias();
error EmptyName();
error InsufficientFees();

// Claim
error ClaimNotAuthorised();
error ClaimMustBeETH();
error ClaimWrongPayout(uint256 expected, uint256 received);

// ERC-721 surface
error AliasApprovalsDisabled();
error UseAcceptAlias();
error NoOffer();


// Owner authorisation
error AuthorizationExpired();
/// @dev Raised when a signed action is not signed by whoever had to sign it — the alias's
///      owner for an owner action, the address an offer names for an acceptance. One error
///      because one code path checks it; the preconditions that distinguish the two cases
///      ({NotAliasOwner}, {NoOffer}) are raised by the callers before it is reached.
error NotSignedByAuthority();

// Pool
error OnlyPoolMaySendETH();

/// @title  HaliasController — who owns the names
/// @notice Mints an alias to an owner, takes the registration fee, and is the only address
///         permitted to write to {HaliasRegistry}.
/// @dev    This contract holds the admin key. That is precisely why it holds no user funds:
///         its entire balance is registration revenue, and the pool it talks to has no
///         admin at all. An auditor reasoning about custody never has to look here, and an
///         auditor reasoning about the admin never has to look at the pool.
///
///         Alias ownership is an ERC-721 so wallets can display it, but the token is not
///         freely transferable. Moving a name has to move its keys at the same instant —
///         otherwise the new owner receives a name whose incoming payments the old owner
///         can still decrypt. {offerAlias} then {acceptAlias} is the only path, and the
///         plain ERC-721 transfer and approval entry points revert.
///
///         The 3-argument `safeTransferFrom` is deliberately not overridden here: OpenZeppelin
///         declares it non-virtual and routes it through the 4-argument overload, which does
///         revert. That is a property of the dependency rather than of this code, so it is
///         pinned by a test instead — see "disables plain ERC-721 transfer and approval".
contract HaliasController is ERC721, EIP712, ReentrancyGuard {
    using Address for address payable;

    IHaliasPool     public immutable pool;
    HaliasRegistry  public immutable registry;

    address public admin;
    address public pendingAdmin;

    /// @notice Outstanding registration reservations, by commitment hash, each recording the
    ///         moment it was made.
    /// @dev    Registration is otherwise a race anyone watching the mempool wins. The alias
    ///         hash travels in plain calldata, so a front-runner registers it first with
    ///         *their own keys* — and then every payment to that name arrives in notes only
    ///         they can decrypt. The victim sees a revert. That is not squatting; it is
    ///         acquiring someone's incoming payments, and it is profitable, which is what
    ///         separates it from exact-copy proof replay (where every destination is bound in
    ///         `paramsHash` and a copier gains nothing).
    ///
    ///         Committing first closes it: an observer sees an opaque hash and cannot build a
    ///         competing commitment without the preimage. By the time the name is public, the
    ///         reservation is already a block old and a would-be front-runner
    ///         cannot manufacture one in the past.
    ///
    ///         The owner is bound into the commitment for a second reason: without it, the
    ///         reveal itself is stealable. `_record` mints to that owner, so copying
    ///         a reveal verbatim would mint the alias to the copier while the victim keeps
    ///         the keys. Binding the sender makes a copied reveal hash to a commitment that
    ///         does not exist.
    ///
    ///         {claim} needs none of this. Its owner is fixed inside the proof through
    ///         `externalData`, so a copied claim registers to the bound owner rather than the
    ///         copier — blockable, but not stealable.
    mapping(bytes32 => uint256) public reservations;

    /// @notice Who an alias has been offered to, if anyone. Zero means no outstanding offer.
    mapping(bytes32 => address) public pendingAliasOwner;
    /// @notice Per-alias acceptance nonce, so a signature cannot be reused on a later offer.
    mapping(bytes32 => uint256) public aliasNonce;

    bytes32 private constant ACCEPT_ALIAS_TYPEHASH = keccak256(
        "AcceptAlias(bytes32 aliasHash,bytes32 spendingCommitment,bytes32 nullifierKeyHash,"
        "bytes32 encryptionPubkey,address to,uint256 nonce,uint256 deadline)"
    );
    bytes32 private constant OFFER_ALIAS_TYPEHASH = keccak256(
        "OfferAlias(bytes32 aliasHash,address to,uint256 nonce,uint256 deadline)"
    );
    bytes32 private constant CANCEL_OFFER_TYPEHASH = keccak256(
        "CancelOffer(bytes32 aliasHash,uint256 nonce,uint256 deadline)"
    );
    /// @dev Signed by the invite alias's owner — an address derived from the invite secret,
    ///      so only whoever holds the code can produce it. Binds the alias being registered as
    ///      well as the invite, so a signature cannot be moved to a different registration.
    bytes32 private constant CLAIM_INVITE_TYPEHASH = keccak256(
        "ClaimInvite(bytes32 inviteAliasHash,bytes32 aliasHash,uint256 nonce,uint256 deadline)"
    );

    bytes32 private constant UPDATE_ALIAS_DATA_TYPEHASH = keccak256(
        "UpdateAliasData(bytes32 aliasHash,bytes32 dataHash,uint256 nonce,uint256 deadline)"
    );

    /// @dev Reservations expire so abandoned ones cannot be hoarded and revealed much later.
    ///
    ///      Seconds rather than blocks, so the window is the same duration everywhere. In
    ///      blocks it would mean a day on mainnet and four hours on a two-second L2, quietly
    ///      shortening how long a legitimate registrant has to reveal. Same reasoning as
    ///      REGISTRY_ROOT_MAX_AGE.
    ///
    ///      There is no matching minimum, because a timestamp already supplies one. Every
    ///      transaction in a block shares its timestamp, so `block.timestamp <= madeAt` is
    ///      satisfied only in a strictly later block — which is exactly the requirement: a
    ///      front-runner who first learns the name from the reveal must not be able to reserve
    ///      and reveal alongside it. Recording the block number as well, packed beside the
    ///      timestamp and unpacked through two helpers, bought nothing this comparison does
    ///      not. If a longer wait is ever wanted (ENS uses 60 seconds), it is a constant added
    ///      to this same comparison, still with no block number involved.
    uint256 public constant MAX_RESERVATION_AGE = 1 days;

    uint256 public registrationFee = 0.001 ether;
    uint256 public accumulatedFees;

    /// @notice Invite entries whose registration fee has been paid forward, each entitling
    ///         exactly one claim, and the address entitled to spend it.
    /// @dev    An invite costs the creator one fee, and that fee covers two registry writes:
    ///         the keys-only entry its note is paid to, and the name the claimer will pick.
    ///         One name, two leaves — it only adds up because the first leaf is worthless,
    ///         which is what {_recordKeysOnly} enforces.
    ///
    ///         An address rather than a flag, because a keys-only entry mints no token and
    ///         there is no `ownerOf` to ask. Set by {createInvite} and deleted by {claim}, so
    ///         it is one-use; consuming it also needs an EIP-712 signature from the address
    ///         stored here, which is derived from the invite secret. Both halves are load
    ///         bearing. Without the deletion the secret holder mints names forever; without
    ///         the signature anyone watching the chain spends a credit they did not pay for.
    ///
    ///         A global counter was the obvious alternative and is unsound: credits would be
    ///         fungible, so one invite could claim as many names as everyone else had bought.
    mapping(bytes32 => address) public prepaidClaim;
    string  private baseTokenURI;

    /// @dev The registration a claim is authorised to perform. Hashed into
    ///      `TransactParams.externalData`, which the pool commits into `paramsHash` — so
    ///      the prover fixes every field here, including `owner`.
    ///
    ///      That binding is what makes relayed claims safe. Minting to `msg.sender` would
    ///      hand the alias to whoever submitted the transaction, and a relayer holding the
    ///      alias could rotate its keys and redirect every future payment to that name.
    struct Registration {
        address owner;
        bytes32 aliasHash;
        bytes32 spendingCommitment;
        bytes32 nullifierKeyHash;   // Poseidon(nullifierKey, 1) — computed off-chain
        bytes32 encryptionPubkey;
    }

    // ── Events ─────────────────────────────────────────────────────────────────

    /// @notice The plaintext behind an alias hash, published by its registrant.
    /// @dev    Optional and one-shot: see {_publishName}.
    event NamePublished(bytes32 indexed aliasHash, string name);
    event RegistrationReserved(bytes32 indexed commitment, uint256 reservedAt);
    event AliasOffered(bytes32 indexed aliasHash, address indexed from, address indexed to);
    event AliasOfferCancelled(bytes32 indexed aliasHash);
    event AliasClaimed(bytes32 indexed aliasHash, address indexed owner, address indexed submitter);
    /// @dev Distinct from {AliasClaimed}, which is the other half. Both register an alias and
    ///      run a pool transaction, so sharing an event would have every creation indexed as a
    ///      redemption — and the two say opposite things about who paid and who received.
    event InviteCreated(bytes32 indexed aliasHash, address indexed owner, address indexed submitter);
    event RegistrationFeeSet(uint256 fee);
    event FeesWithdrawn(address indexed to, uint256 amount);
    event AdminTransferStarted(address indexed from, address indexed to);
    event AdminTransferred(address indexed from, address indexed to);

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    /// @dev Authorises an action reserved to an alias's owner. A signature is the only way to
    ///      express that intent — `msg.sender` is never consulted.
    ///
    ///      There is deliberately no second path where an empty signature means the owner is
    ///      submitting for themselves. The owner is not an account anyone transacts from: a
    ///      client derives its owner key from its recovery phrase, so that key holds no ETH and
    ///      cannot pay for a transaction — it can only ever sign, while some funded wallet
    ///      submits. A sender-based path would encode the assumption that owning a name and
    ///      paying for gas are the same account,
    ///      which is exactly the coupling this removes.
    ///
    ///      What it buys: `ownerOf` no longer names a wallet anyone uses, so it stops tying a
    ///      real address to an alias in public state; an owner recovering from a compromised
    ///      key needs no ETH; and an alias moves between wallets without moving at all.
    ///
    ///      {SignatureChecker} accepts EOAs and ERC-1271 contracts alike, so an alias held by
    ///      a smart account still works.
    ///
    ///      The nonce is bumped on every authorised action, so the rule is one sentence: any
    ///      authorised action on an alias invalidates every signature outstanding for it.
    function _authorizeOwner(
        bytes32 aliasHash,
        bytes32 structHash,
        uint256 deadline,
        bytes calldata signature
    ) private returns (address) {
        // An unregistered alias has no owner, and zero must be rejected explicitly rather
        // than left to the signature check: a malformed signature recovers to the zero
        // address, so `owner == address(0)` would otherwise authorise anyone against a token
        // that does not exist.
        address owner = _ownerOf(uint256(aliasHash));
        if (owner == address(0)) revert NotAliasOwner();

        _consumeAuthorization(owner, aliasHash, structHash, deadline, signature);
        return owner;
    }

    /// @dev The three things every signed action needs, in the one place they can be kept in
    ///      step: the deadline, the signature, and the nonce bump that stops the signature
    ///      being replayed.
    ///
    ///      Together, because the bump is the replay protection and separating it from the
    ///      check is how a future signed action ends up replayable — verified, accepted, and
    ///      still valid afterwards, with nothing to notice. Nothing can call this and skip it.
    ///
    ///      EIP-712 itself stops none of that. Its domain separator carries chainId and
    ///      verifyingContract, so a signature cannot cross to another chain or another
    ///      deployment, and distinct typehashes stop one message being read as another — but
    ///      the same message, on this contract, verifies as many times as it is submitted.
    ///      That is what `aliasNonce` is for, keyed by alias rather than by signer so that
    ///      activity on one alias never invalidates a signature outstanding for a different
    ///      one, and so that it keeps tracking the alias after the alias changes hands.
    function _consumeAuthorization(
        address principal,
        bytes32 aliasHash,
        bytes32 structHash,
        uint256 deadline,
        bytes calldata signature
    ) private {
        if (block.timestamp > deadline) revert AuthorizationExpired();
        if (!SignatureChecker.isValidSignatureNow(principal, _hashTypedDataV4(structHash), signature)) {
            revert NotSignedByAuthority();
        }
        unchecked { aliasNonce[aliasHash]++; }
    }

    /// @dev `_admin` is explicit rather than `msg.sender`: this deploys through
    ///      {HaliasDeployer}, so `msg.sender` is that contract. A previous deployment set
    ///      admin to the deployer and
    ///      stranded every admin function permanently.
    constructor(address _pool, address _registry, address _admin)
        ERC721("Halias Alias", "HLS") EIP712("Halias", "1")
    {
        if (_pool == address(0) || _registry == address(0) || _admin == address(0)) {
            revert ZeroDependency();
        }
        pool     = IHaliasPool(_pool);
        registry = HaliasRegistry(_registry);
        admin    = _admin;
    }

    // ── Registration ───────────────────────────────────────────────────────────

    /// @notice Reserve a registration before revealing what it is for.
    /// @param  commitment  {registrationCommitment} of the registration you intend to make.
    /// @dev    Deliberately unauthenticated: a commitment reveals nothing, and refusing to
    ///         store one would only reintroduce the race it exists to close.
    ///
    ///         A live commitment cannot be reset, and that is load-bearing. The hash is
    ///         public the moment it is made, so anyone could otherwise re-commit someone
    ///         else's in the same block as their reveal — pushing `madeAt` to the current
    ///         block and failing the reveal with {ReservationTooNew}, indefinitely, for the price
    ///         of gas. Nobody can front-run the *first* commitment because that needs the
    ///         preimage, so refusing to overwrite closes the window entirely.
    ///
    ///         An expired one can be replaced, which is how a caller recovers from letting
    ///         a commitment go stale.
    /// @notice First of the two transactions a registration takes. Reserves the right to
    ///         reveal a name later without saying which name.
    /// @dev    Named for what it commits to rather than just `commit`: this contract also
    ///         takes claims, offers and acceptances, and none of those go through here.
    ///         Pairs with {registrationCommitment}, which builds the hash.
    function reserveRegistration(bytes32 commitment) external {
        uint256 prev = reservations[commitment];
        if (prev != 0 && block.timestamp <= prev + MAX_RESERVATION_AGE) {
            revert ReservationPending();
        }

        reservations[commitment] = block.timestamp;
        emit RegistrationReserved(commitment, block.timestamp);
    }

    /// @dev The commitment a registration reveals against.
    ///
    ///      `internal`, and that is the point. As an external `pure` helper this was callable
    ///      over `eth_call` with the plaintext name as its first argument — which hands the
    ///      name to whatever node answers the call, *before* the opaque commitment is
    ///      broadcast. That inverts the whole mechanism: commit-reveal exists so nobody learns
    ///      the name until front-running it is impossible, and the node answering is also the
    ///      one watching the mempool it would be front-run in.
    ///
    ///      A caller must therefore reproduce this encoding rather than ask for it. That is
    ///      four lines, and it is not left to chance: the SDK exports `registrationCommitment`
    ///      and SdkPreimage.test.ts proves the two agree by precommitting with the SDK's hash
    ///      and revealing against this one — a disagreement surfaces as {NoReservation} there
    ///      rather than as a stranded registration in production.
    function registrationCommitment(
        string calldata name,
        bytes32 spendingCommitment,
        bytes32 nullifierKeyHash,
        bytes32 encryptionPubkey,
        address owner,
        bytes32 salt
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(
            aliasToHash(name), spendingCommitment, nullifierKeyHash, encryptionPubkey, owner, salt
        ));
    }

    /// @notice Register an alias, paying the fee from your own balance.
    /// @param  name  The plaintext behind `aliasHash`, or "" to keep it off chain.
    /// @param  salt  The salt used in the matching {reserveRegistration}.
    /// @param  owner The address that will hold the name. Not `msg.sender`: a client derives
    ///         this from its own recovery phrase, so the name travels with the keys rather
    ///         than with whichever wallet happened to pay. `ownerOf` then reveals an address
    ///         that never transacts, instead of publicly tying a real EOA to the alias.
    ///
    ///         It is bound into the commitment, so naming someone else's address cannot be
    ///         forced on them by front-running a reveal: the commitment a victim published
    ///         does not match one with a different owner in it.
    function revealRegistration(
        string calldata name,
        bytes32 spendingCommitment,
        bytes32 nullifierKeyHash,
        bytes32 encryptionPubkey,
        address owner,
        bytes32 salt
    ) external payable nonReentrant {
        bytes32 c = registrationCommitment(
            name, spendingCommitment, nullifierKeyHash, encryptionPubkey, owner, salt
        );
        uint256 madeAt = reservations[c];
        if (madeAt == 0)                                        revert NoReservation();
        // A strictly later block, which is the whole requirement — see MAX_RESERVATION_AGE.
        if (block.timestamp <= madeAt)                          revert ReservationTooNew();
        if (block.timestamp >  madeAt + MAX_RESERVATION_AGE)    revert ReservationExpired();
        // One-shot: consumed here so the slot is reclaimed and the same tuple can be
        // committed again immediately. Replay is already impossible — the commitment binds
        // the name, and re-registering it reverts as taken.
        delete reservations[c];

        _takeFeeAndRecord(name, spendingCommitment, nullifierKeyHash, encryptionPubkey, owner);
    }

    /// @notice Register in one transaction, with no commitment.
    /// @dev    Front-runnable wherever the mempool is public, and profitably so: the name
    ///         travels in this call's calldata, so anyone watching can register it first
    ///         with *their own* keys and receive every payment afterwards intended for
    ///         whoever asked for it. That is what {revealRegistration}'s two-step flow exists to
    ///         prevent, and it is why the SDK uses that path by default.
    ///
    ///         This is the right call only where the mempool is not public — an encrypted
    ///         or threshold-decrypted chain, or a private inclusion channel. It is left
    ///         permanently available rather than gated because these contracts cannot be
    ///         upgraded and the registry's controller is immutable: a switch would have to
    ///         be an admin power, and the deployment that needs this path may not exist yet.
    ///
    ///         Even then the guarantee is narrower than it looks. An encrypted mempool hides
    ///         a transaction from public observers, not necessarily from whoever decrypts
    ///         and builds the block.
    function directRegistration(
        string calldata name,
        bytes32 spendingCommitment,
        bytes32 nullifierKeyHash,
        bytes32 encryptionPubkey,
        address owner
    ) external payable nonReentrant {
        _takeFeeAndRecord(name, spendingCommitment, nullifierKeyHash, encryptionPubkey, owner);
    }

    /// @dev Everything the two registration paths share. They differ only in what they
    ///      require *before* this: a matured commitment, or nothing.
    function _takeFeeAndRecord(
        string calldata name,
        bytes32 spendingCommitment,
        bytes32 nullifierKeyHash,
        bytes32 encryptionPubkey,
        address owner
    ) private {
        if (msg.value != registrationFee) revert WrongRegistrationFee();
        accumulatedFees += msg.value;

        // `owner`, not `msg.sender`. Whoever pays need not be whoever holds the name, which is
        // what lets a client own its aliases with a key derived from its phrase and lets a
        // relayer pay for a registration without acquiring it. `_record` rejects the zero
        // address, so an omitted owner fails rather than minting to nobody.
        _record(Registration({
            owner:            owner,
            aliasHash:        aliasToHash(name),
            spendingCommitment:   spendingCommitment,
            nullifierKeyHash: nullifierKeyHash,
            encryptionPubkey: encryptionPubkey
        }), name);
    }

    /// @notice Create an invite: register the account its note pays, and fund it, in one
    ///         transaction.
    /// @dev    One fee, from the creator's wallet, covering two registry writes — this
    ///         throwaway account and the name the claimer will choose. Only the second is a
    ///         name; the first is a leaf and nothing else. Nothing is taken from the pool,
    ///         which is the point: see {claim}.
    ///
    ///         The entry it registers has no name and no token — see {_recordKeysOnly}. That
    ///         is what makes the arithmetic hold. The deal works because the first leaf is
    ///         worthless, and an entry whose identity is forced to
    ///         `keccak256(spendingCommitment)` cannot be a name however hard the caller tries.
    ///         An earlier draft registered a real alias and had to police its *shape* instead,
    ///         which left the whole namespace one forgotten check away from selling two names
    ///         for the price of one.
    ///
    ///         Same armed-leaf shape as {claim}: the note is addressed to an alias that does
    ///         not exist when the proof is built, so the proof carries the insertion and the
    ///         registry is armed across exactly the one call that may perform it.
    function createInvite(
        Registration calldata r,
        TransactParams calldata p,
        bytes calldata encryptedOutput0,
        bytes calldata encryptedOutput1,
        bytes calldata proof
    ) external payable nonReentrant {
        if (keccak256(abi.encode(r)) != p.externalData) revert ClaimNotAuthorised();
        if (p.tokenAddress != address(0)) revert ClaimMustBeETH();
        if (msg.value != registrationFee) revert WrongRegistrationFee();
        // Nothing may leave to a public recipient. A relayer is still payable, because the
        // pool settles `relayerFee` separately from `recipientPayout` — so someone else can
        // submit this and be reimbursed from the note, though they would be paying the fee
        // from their own wallet to do it. Withdrawing on this path is refused twice over:
        // here, and by the pool's own {_checkPayee} if the recipient were zero with value
        // still owed.
        if (p.recipient != address(0)) revert InviteMustNotPayOut();
        accumulatedFees += msg.value;

        _recordKeysOnly(r);
        // The credit carries the address allowed to spend it. Set before the pool is called,
        // not after: a credit written after an external call exists for a window something
        // else could act in.
        prepaidClaim[r.aliasHash] = r.owner;
        registry.authorizePendingLeaf(r.aliasHash);

        // Nothing may leave the pool on this path: the note is funded from the creator's own
        // shielded balance, so `publicAmount` is zero and the transaction is a transfer.
        uint256 balanceBefore = address(this).balance;
        pool.transact(p, encryptedOutput0, encryptedOutput1, proof);
        uint256 received = address(this).balance - balanceBefore;
        registry.clearPendingLeaf();
        if (received != 0) revert ClaimMustPayNothing(received);

        emit InviteCreated(r.aliasHash, r.owner, msg.sender);
    }

    /// @notice Redeem an invite: register a name against the credit its creator paid for,
    ///         with no ETH of your own.
    /// @dev    The other half of {createInvite}: the inviter funded a note against a keypair
    ///         derived from the invite secret and prepaid the registration in ETH, and this
    ///         spends both. The claimer pays gas, or names a relayer in `p.relayerFee` and
    ///         lets the pool pay it out of the note — a third party selling inclusion, which
    ///         is a different thing from this contract taking a cut.
    ///
    ///         Ordering is load-bearing. The claimer's change note is a non-zero output, and
    ///         the circuit demands registry membership for every non-zero output — so their
    ///         own alias has to be in the tree the proof is checked against, a tree that does
    ///         not yet exist when the proof is built.
    ///
    ///         The proof therefore carries the insertion. It proves against the root from
    ///         *before* this registration — on chain, and inside the freshness window — and
    ///         derives the tree that results from adding the claimer's leaf. The registry
    ///         write comes first only so {authorizePendingLeaf} can read the leaf back out of
    ///         stored state rather than trusting an argument.
    ///
    ///         Arming is what stops this being a hole. Without it a prover on the ordinary
    ///         `transact` path could claim an insertion of their own unregistered keys into a
    ///         tree of their choosing and pay themselves, which is precisely what the registry
    ///         proof exists to prevent.
    /// @param inviteAliasHash The invite whose prepaid registration this consumes.
    /// @param deadline        When `signature` stops being valid.
    /// @param signature       From the invite alias's owner, an address derived from the
    ///                        invite secret — so only whoever holds the code can redeem it.
    function claim(
        Registration calldata r,
        TransactParams calldata p,
        bytes calldata encryptedOutput0,
        bytes calldata encryptedOutput1,
        bytes calldata proof,
        string calldata name,
        bytes32 inviteAliasHash,
        uint256 deadline,
        bytes calldata signature
    ) external nonReentrant {
        // The prover authorised exactly this registration. A submitter can decline to
        // submit; it cannot substitute itself for `r.owner` or alter a single key.
        if (keccak256(abi.encode(r)) != p.externalData) revert ClaimNotAuthorised();
        if (p.tokenAddress != address(0)) revert ClaimMustBeETH();

        // The fee was paid at creation. Both halves are needed: the deletion makes it
        // one-use, so the secret holder cannot mint free names forever, and the signature
        // makes it theirs, so a stranger cannot spend a credit they did not pay for.
        address inviteOwner = prepaidClaim[inviteAliasHash];
        if (inviteOwner == address(0)) revert NoPrepaidClaim();
        delete prepaidClaim[inviteAliasHash];
        // Not {_authorizeOwner}: that resolves the principal through `ownerOf`, and an invite
        // entry mints no token. The stored address is the authority, and it was fixed when the
        // fee was paid.
        _consumeAuthorization(
            inviteOwner,
            inviteAliasHash,
            keccak256(abi.encode(
                CLAIM_INVITE_TYPEHASH, inviteAliasHash, r.aliasHash,
                aliasNonce[inviteAliasHash], deadline
            )),
            deadline,
            signature
        );

        _record(r, name);
        registry.authorizePendingLeaf(r.aliasHash);

        // The pool settles the relayer directly, and nothing is owed to this contract. A
        // relayer being paid out of the note is a third party selling inclusion; this
        // contract taking a fee out of the note would be revenue drawn from the pool, which
        // is the thing the prepaid credit exists to avoid.
        uint256 balanceBefore = address(this).balance;
        pool.transact(p, encryptedOutput0, encryptedOutput1, proof);
        uint256 received = address(this).balance - balanceBefore;
        registry.clearPendingLeaf();
        if (received != 0) revert ClaimMustPayNothing(received);

        emit AliasClaimed(r.aliasHash, r.owner, msg.sender);
    }

    /// @dev A registry entry with keys and nothing else — no name, no token, no place in the
    ///      namespace. What an invite needs: the note must prove membership against a leaf, and
    ///      a leaf needs keys, but nothing about that requires a name anyone could type.
    ///
    ///      Its identity is `keccak256(spendingCommitment)`, so the caller cannot choose it.
    ///      That is what makes a free entry safe here: the fee buys a *name*, and this can
    ///      never be one — not by collision either, since matching a name's hash would mean
    ///      finding a spending commitment that keccaks to it.
    function _recordKeysOnly(Registration memory r) private {
        if (r.owner == address(0)) revert InvalidOwner();
        if (r.aliasHash != keccak256(abi.encode(r.spendingCommitment))) revert NotAnInviteEntry();
        registry.register(r.aliasHash, r.spendingCommitment, r.nullifierKeyHash, r.encryptionPubkey);
    }

    function _record(Registration memory r, string calldata name) private {
        if (r.owner == address(0)) revert InvalidOwner();

        // Registry first: it owns every invariant about the tree, including rejecting an
        // alias that is already taken. Minting before that would let a failed registration
        // leave a token behind.
        registry.register(r.aliasHash, r.spendingCommitment, r.nullifierKeyHash, r.encryptionPubkey);

        // `_mint`, deliberately, not `_safeMint` — static analysers flag this, so: `_safeMint`
        // calls `onERC721Received` on the recipient, and the recipient is `r.owner`, chosen by
        // the prover. That hands attacker-controlled code a re-entry point in the middle of a
        // claim, while the registry holds an armed pending leaf. `nonReentrant` stops re-entry
        // into `claim` but not calls into everything else, and reasoning about that window is
        // strictly worse than not opening it. The cost is that an alias minted to a contract
        // that cannot handle ERC-721 is stuck — an owner who asked for exactly that address.
        _mint(r.owner, uint256(r.aliasHash));
        _publishName(r.aliasHash, name);
    }

    /// @dev Publishes the plaintext when one is supplied, checked against the hash so a
    ///      false name cannot be attached to someone else's alias.
    ///
    ///      Registration is the only moment this is useful. Someone who has forgotten their
    ///      name cannot supply it later either, so a publish-afterwards function would not
    ///      address the failure it exists for — and the plaintext exists nowhere else, since
    ///      `aliasHash` is one-way.
    ///
    ///      Empty is accepted for an alias with no name to publish, because requiring one
    ///      would mean requiring a preimage that may not exist. An invite entry is the case:
    ///      it goes through {_recordKeysOnly}, never here, and has no plaintext at all. It is deliberately NOT a
    ///      privacy setting, and the client no longer offers it as one. Withholding the name
    ///      of a *named* alias hides very little — the hash is public in the registration
    ///      event either way, so any name short enough to type falls to a wordlist — while
    ///      costing recoverability outright.
    function _publishName(bytes32 aliasHash, string calldata name) private {
        if (bytes(name).length == 0) return;
        if (keccak256(bytes(name)) != aliasHash) revert NameDoesNotMatchAlias();
        emit NamePublished(aliasHash, name);
    }

    /// @dev    No charset rule is enforced here. `name` is any non-empty byte string whose
    ///         keccak matches the alias hash, so two names that *look* alike register as two
    ///         different aliases and both are valid. Restricting to lowercase alphanumerics
    ///         and hyphens is a client convention (see `normalizeAlias`), which means a
    ///         hand-rolled caller can register a homoglyph of someone else's name.
    ///
    ///         That is deliberate: the contract cannot know which scripts a display layer
    ///         renders confusably, and encoding a charset here would freeze one answer into
    ///         an immutable contract. The defence belongs where names are shown.
    /// @notice The alias hash a name registers under. Exposed so a client derives it from
    ///         the same code the contract uses rather than reimplementing keccak over the
    ///         same bytes and discovering the disagreement at registration.
    /// @dev    An empty name is rejected here rather than silently registering under
    ///         `keccak("")` — a single fixed hash that exactly one alias could ever occupy,
    ///         and which would look like an ordinary "alias taken" to everyone after.
    function aliasToHash(string calldata name) public pure returns (bytes32) {
        if (bytes(name).length == 0) revert EmptyName();
        return keccak256(bytes(name));
    }


    // ── Alias maintenance ──────────────────────────────────────────────────────

    // There is no `updateKeys`. It rotated the nullifier and encryption keys but never the
    // spending commitment — so the one compromise that loses money was the one it could not
    // address, behind a name that implied otherwise. Offering an alias to yourself and
    // accepting it with fresh keys rotates all three, which is strictly more, and once
    // {offerAlias} carries a signature the whole rotation is relayable: exactly what someone
    // recovering from a compromise needs, since that is when they are least able to pay.
    //
    // It also removes a registry leaf writer, and every leaf write invalidates claims in
    // flight (F1). What it costs is `dataHash`, which {HaliasRegistry-reassign} clears and
    // which is zero on every alias in existence — reserved for proof-of-innocence and not yet
    // carrying anything. When it does, the distinction belongs on `reassign` keyed on whether
    // the owner actually changed, rather than in a separate function.

    /// @dev `nonReentrant` is defence in depth rather than a live fix. A relayer holding
    ///      control during a claim's payout could otherwise reach this, and while the pool
    ///      has already verified the registry root by then — so a mid-flight write cannot
    ///      affect the executing transaction — that safety depends on the ordering inside
    ///      a different contract. Guarding here keeps the argument local.
    function updateAliasData(
        bytes32 aliasHash,
        bytes32 newDataHash,
        uint256 deadline,
        bytes calldata signature
    ) external nonReentrant {
        _authorizeOwner(aliasHash, keccak256(abi.encode(
            UPDATE_ALIAS_DATA_TYPEHASH, aliasHash, newDataHash,
            aliasNonce[aliasHash], deadline
        )), deadline, signature);
        registry.setDataHash(aliasHash, newDataHash);
    }

    /// @notice Offer an alias to someone. Nothing moves until they accept.
    /// @dev    Recording an intent rather than performing the transfer is what makes the
    ///         handover safe. Taking the new owner *and* the new keys from the seller in one
    ///         step would let a seller hand over the token while installing keys they
    ///         controlled, leaving the recipient owning a name whose payments arrive for
    ///         someone else. The contract cannot detect that: keys come from an EIP-191
    ///         wallet signature through Poseidon, so there is no on-chain relationship
    ///         between an address and a spending commitment.
    ///
    ///         Only the recipient can assert which keys are theirs, so only the recipient can
    ///         complete a transfer. Until then this changes nothing at all — the seller keeps
    ///         the token, the registry keeps its keys, and payments keep arriving for the
    ///         seller. There is no in-transit state to get wrong.
    ///
    ///         Offering an alias to yourself is the key-rotation path: accept it with fresh
    ///         keys and {HaliasRegistry-reassign} replaces all three, including the spending
    ///         spending commitment. Signing both halves makes the whole rotation relayable.
    function offerAlias(
        bytes32 aliasHash,
        address to,
        uint256 deadline,
        bytes calldata signature
    ) external nonReentrant {
        if (to == address(0)) revert InvalidOwner();
        address owner = _authorizeOwner(aliasHash, keccak256(abi.encode(
            OFFER_ALIAS_TYPEHASH, aliasHash, to, aliasNonce[aliasHash], deadline
        )), deadline, signature);
        pendingAliasOwner[aliasHash] = to;
        emit AliasOffered(aliasHash, owner, to);
    }

    /// @notice Everything needed to authorise an action on `aliasHash`, in one call.
    /// @dev    A client cannot sign without knowing who has to sign and what nonce to carry,
    ///         and reading those separately costs two sequential round-trips before a
    ///         signature can even be produced. This is not new state — it reads what the three
    ///         mappings already hold — it exists so a client depends on one call rather than
    ///         three, and stores none of it.
    ///
    ///         Deliberately read rather than remembered: a client that tracked the nonce
    ///         itself would need durable state that survives a reinstall, stays correct across
    ///         two devices holding the same phrase, and desyncs the moment anyone submits a
    ///         relayed action on its behalf.
    /// @return owner        Who must sign an owner action. Zero if the alias is unregistered.
    /// @return pendingOwner Who must sign an acceptance. Zero if nothing is offered.
    /// @return nonce        What either signature must carry.
    function aliasAuth(bytes32 aliasHash) external view returns (
        address owner,
        address pendingOwner,
        uint256 nonce
    ) {
        return (_ownerOf(uint256(aliasHash)), pendingAliasOwner[aliasHash], aliasNonce[aliasHash]);
    }

    /// @notice Withdraw an outstanding offer.
    function cancelOffer(
        bytes32 aliasHash,
        uint256 deadline,
        bytes calldata signature
    ) external nonReentrant {
        _authorizeOwner(aliasHash, keccak256(abi.encode(
            CANCEL_OFFER_TYPEHASH, aliasHash, aliasNonce[aliasHash], deadline
        )), deadline, signature);
        delete pendingAliasOwner[aliasHash];
        emit AliasOfferCancelled(aliasHash);
    }

    /// @notice Complete a transfer, installing keys the recipient authorised.
    /// @dev    Authorisation is a signature rather than `msg.sender`, so a relayer can submit
    ///         this for a recipient holding no ETH — the same reason {claim} binds its owner
    ///         in the proof instead of reading the sender. {SignatureChecker} accepts both
    ///         EOAs and ERC-1271 contracts, which is what lets an escrow be a recipient.
    ///
    ///         The signature covers the keys, so a submitter cannot substitute its own; and
    ///         the alias's nonce, so a signature cannot be replayed against a later offer of
    ///         the same alias to the same address.
    function acceptAlias(
        bytes32 aliasHash,
        bytes32 newSpendingCommitment,
        bytes32 newNullifierKeyHash,
        bytes32 newEncryptionPubkey,
        uint256 deadline,
        bytes calldata signature
    ) external nonReentrant {
        address to = pendingAliasOwner[aliasHash];
        if (to == address(0)) revert NoOffer();

        // The recipient signs, not the owner — which is why this cannot go through
        // {_authorizeOwner}: routing it there would let the *seller* authorise the acceptance
        // and choose the recipient's keys, which is the bug offer/accept exists to prevent.
        // The shared half is the check itself.
        _consumeAuthorization(to, aliasHash, keccak256(abi.encode(
            ACCEPT_ALIAS_TYPEHASH, aliasHash,
            newSpendingCommitment, newNullifierKeyHash, newEncryptionPubkey,
            to, aliasNonce[aliasHash], deadline
        )), deadline, signature);

        // Consumed once the signature is good: one offer, one acceptance.
        delete pendingAliasOwner[aliasHash];

        _transfer(ownerOf(uint256(aliasHash)), to, uint256(aliasHash));
        registry.reassign(aliasHash, newSpendingCommitment, newNullifierKeyHash, newEncryptionPubkey);
    }


    // ── Admin ──────────────────────────────────────────────────────────────────
    //
    // Everything here touches revenue or metadata. None of it can reach a user's funds:
    // those live in the pool, which has no admin at all.

    function setRegistrationFee(uint256 _fee) external onlyAdmin {
        registrationFee = _fee;
        emit RegistrationFeeSet(_fee);
    }

    function setBaseTokenURI(string calldata baseURI) external onlyAdmin {
        baseTokenURI = baseURI;
    }

    /// @dev `nonReentrant` for uniformity, not because CEI leaves a hole — the balance is
    ///      reduced before the send, so a re-entrant withdrawal sees the lower figure and a
    ///      re-entrant registration only adds to it. It is the one ETH-sending function that
    ///      lacked the guard, and "this one is safe for a different reason than the others"
    ///      is a thing an auditor has to re-derive every time.
    function withdrawFees(address payable to, uint256 amount) external nonReentrant onlyAdmin {
        if (to == address(0)) revert InvalidOwner();
        if (amount > accumulatedFees) revert InsufficientFees();
        accumulatedFees -= amount;
        to.sendValue(amount);
        emit FeesWithdrawn(to, amount);
    }

    // No token rescue. It existed to recover tokens sent here by mistake, which is a
    // scenario this contract has no business in: it never holds tokens, and user assets are
    // in the pool, which has no admin at all. Keeping it meant one more admin-reachable path
    // for an auditor to rule out, in exchange for insuring against a mistake nobody has made.
    // Tokens sent here are stuck, and that is the correct outcome for value the contract was
    // never meant to receive.

    /// @dev Two-step, so a typo in the new address cannot orphan the role.
    function transferAdmin(address _admin) external onlyAdmin {
        if (_admin == address(0)) revert InvalidOwner();
        pendingAdmin = _admin;
        emit AdminTransferStarted(admin, _admin);
    }

    function acceptAdmin() external {
        if (msg.sender != pendingAdmin) revert NotPendingAdmin();
        address previous = admin;
        admin = pendingAdmin;
        pendingAdmin = address(0);
        emit AdminTransferred(previous, admin);
    }

    // ── ERC-721 restrictions ───────────────────────────────────────────────────

    function transferFrom(address, address, uint256) public pure override {
        revert UseAcceptAlias();
    }

    function safeTransferFrom(address, address, uint256, bytes memory) public pure override {
        revert UseAcceptAlias();
    }

    /// @dev Approvals are disabled outright rather than merely unused. An approval that
    ///      cannot be exercised is a footgun: it looks like it delegates the alias and
    ///      silently does nothing.
    function approve(address, uint256) public pure override {
        revert AliasApprovalsDisabled();
    }

    function setApprovalForAll(address, bool) public pure override {
        revert AliasApprovalsDisabled();
    }

    function _baseURI() internal view override returns (string memory) {
        return baseTokenURI;
    }

    // ── Pool payouts ───────────────────────────────────────────────────────────

    /// @dev The pool pays a claim's registration fee here mid-call. Nothing else has any
    ///      reason to push ETH at this contract, and untracked ETH would sit outside
    ///      `accumulatedFees` where `withdrawFees` cannot reach it.
    receive() external payable {
        if (msg.sender != address(pool)) revert OnlyPoolMaySendETH();
    }
}
