import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
    LAMPORTS_PER_SOL,
    PublicKey,
    SystemProgram,
    Transaction,
} from "@solana/web3.js";
import {
    TOKEN_PROGRAM_ID,
    createAccount,
    createMint,
    getAccount,
    mintTo,
} from "@solana/spl-token";
import { NftLendBorrow } from "../target/types/nft_lend_borrow";
import { assert } from "chai";

describe("nft-lend-borrow", () => {
    // Configure the client to use the local cluster.
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);

    const program = anchor.workspace.NftLendBorrow as Program<NftLendBorrow>;

    let assetMint: PublicKey;

    let lenderAssetAccount: PublicKey;
    let borrowerAssetAccount: PublicKey;
    let vaultAssetAccount: PublicKey;

    let payer = anchor.web3.Keypair.generate();
    let mintAuthority = anchor.web3.Keypair.generate();
    let assetPoolAuthority = anchor.web3.Keypair.generate();

    let lender = anchor.web3.Keypair.generate();
    let borrower = anchor.web3.Keypair.generate();

    let lenderInitialBalance = 10000000000;
    let borrowerInitialBalance = 5000000000;

    let collectionPoolPDA: PublicKey;
    let offerPDA: PublicKey;
    let activeLoanPDA: PublicKey;
    let vaultPDA: PublicKey;
    let vaultAuthorityPDA: PublicKey;

    let collectionId = new PublicKey(
        "J1S9H3QjnRtBbbuD4HjPV6RpRhwuk4zKbxsnCHuTgh9w"
    );

    it("Can initialize the state of the world", async () => {
        const transferSig = await provider.connection.requestAirdrop(
            payer.publicKey,
            20000000000
        );

        const latestBlockHash = await provider.connection.getLatestBlockhash();

        await provider.connection.confirmTransaction({
            blockhash: latestBlockHash.blockhash,
            lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
            signature: transferSig,
        });

        const tx = new Transaction();

        tx.add(
            SystemProgram.transfer({
                fromPubkey: payer.publicKey,
                toPubkey: mintAuthority.publicKey,
                lamports: 1000000000,
            }),
            SystemProgram.transfer({
                fromPubkey: payer.publicKey,
                toPubkey: assetPoolAuthority.publicKey,
                lamports: 1000000000,
            }),
            SystemProgram.transfer({
                fromPubkey: payer.publicKey,
                toPubkey: lender.publicKey,
                lamports: lenderInitialBalance,
            }),
            SystemProgram.transfer({
                fromPubkey: payer.publicKey,
                toPubkey: borrower.publicKey,
                lamports: borrowerInitialBalance,
            })
        );

        await provider.sendAndConfirm(tx, [payer]);

        assetMint = await createMint(
            provider.connection,
            payer,
            mintAuthority.publicKey,
            undefined,
            0,
            undefined,
            undefined,
            TOKEN_PROGRAM_ID
        );

        lenderAssetAccount = await createAccount(
            provider.connection,
            payer,
            assetMint,
            lender.publicKey,
            undefined,
            undefined,
            TOKEN_PROGRAM_ID
        );

        borrowerAssetAccount = await createAccount(
            provider.connection,
            payer,
            assetMint,
            borrower.publicKey,
            undefined,
            undefined,
            TOKEN_PROGRAM_ID
        );

        await mintTo(
            provider.connection,
            payer,
            assetMint,
            borrowerAssetAccount,
            mintAuthority,
            1
        );

        let [collectionPoolAddress, _collectionBump] =
            anchor.web3.PublicKey.findProgramAddressSync(
                [
                    anchor.utils.bytes.utf8.encode("collection-pool"),
                    collectionId.toBuffer(),
                ],
                program.programId
            );

        collectionPoolPDA = collectionPoolAddress;

        const borrowerAssetTokenAccount = await getAccount(
            provider.connection,
            borrowerAssetAccount
        );

        assert.strictEqual(borrowerAssetTokenAccount.amount.toString(), "1");
    });

    let loanDuration = 10;

    it("Can create pool", async () => {
        await program.methods
            .createPool(collectionId, new anchor.BN(loanDuration))
            .accounts({
                collectionPool: collectionPoolPDA,
                authority: assetPoolAuthority.publicKey,
                systemProgram: anchor.web3.SystemProgram.programId,
            })
            .signers([assetPoolAuthority])
            .rpc();

        const createdPool = await program.account.collectionPool.fetch(
            collectionPoolPDA
        );

        assert.strictEqual(
            createdPool.collectionId.toBase58(),
            collectionId.toBase58()
        );
        assert.strictEqual(createdPool.duration.toNumber(), loanDuration);
        assert.strictEqual(
            createdPool.poolOwner.toBase58(),
            assetPoolAuthority.publicKey.toBase58()
        );
    });

    let totalOffers = 0;
    let offerAmount = new anchor.BN(2 * LAMPORTS_PER_SOL);

    it("Can offer loan", async () => {
        let [offer, _offerBump] = anchor.web3.PublicKey.findProgramAddressSync(
            [
                anchor.utils.bytes.utf8.encode("offer"),
                collectionPoolPDA.toBuffer(),
                lender.publicKey.toBuffer(),
                Buffer.from(totalOffers.toString()),
            ],
            program.programId
        );
        offerPDA = offer;

        let [vault, _vaultBump] = anchor.web3.PublicKey.findProgramAddressSync(
            [
                anchor.utils.bytes.utf8.encode("vault"),
                collectionPoolPDA.toBuffer(),
                lender.publicKey.toBuffer(),
                Buffer.from(totalOffers.toString()),
            ],
            program.programId
        );
        vaultPDA = vault;

        await program.methods
            .offerLoan(offerAmount)
            .accounts({
                offerLoan: offerPDA,
                vaultAccount: vaultPDA,
                collectionPool: collectionPoolPDA,
                lender: lender.publicKey,
                systemProgram: anchor.web3.SystemProgram.programId,
            })
            .signers([lender])
            .rpc();

        const vaultAccount = await provider.connection.getAccountInfo(vaultPDA);
        const lenderAccount = await provider.connection.getAccountInfo(
            lender.publicKey
        );

        assert.isAbove(vaultAccount.lamports, offerAmount.toNumber());
        assert.isBelow(
            lenderAccount.lamports,
            lenderInitialBalance - offerAmount.toNumber()
        );

        const createdOffer = await program.account.offer.fetch(offerPDA);

        assert.strictEqual(
            createdOffer.collection.toBase58(),
            collectionPoolPDA.toBase58()
        );
        assert.strictEqual(
            createdOffer.offerLamportAmount.toNumber(),
            offerAmount.toNumber()
        );
        assert.strictEqual(
            createdOffer.repayLamportAmount.toNumber(),
            offerAmount.toNumber() + (10 / 100) * offerAmount.toNumber()
        );
        assert.strictEqual(
            createdOffer.lender.toBase58(),
            lender.publicKey.toBase58()
        );
        assert.strictEqual(createdOffer.isLoanTaken, false);
    });

    let loanStartTS: number;
    let loanRepayTS: number;

    it("Can borrow loan", async () => {
        let [activeloan, _activeLoanBump] =
            anchor.web3.PublicKey.findProgramAddressSync(
                [
                    anchor.utils.bytes.utf8.encode("active-loan"),
                    offerPDA.toBuffer(),
                ],
                program.programId
            );

        activeLoanPDA = activeloan;

        let [vaultAsset, _vaultAssetBump] =
            anchor.web3.PublicKey.findProgramAddressSync(
                [
                    anchor.utils.bytes.utf8.encode("vault-asset-account"),
                    offerPDA.toBuffer(),
                ],
                program.programId
            );

        vaultAssetAccount = vaultAsset;

        let [vaultAuth, _vaultAuthBump] =
            anchor.web3.PublicKey.findProgramAddressSync(
                [collectionPoolPDA.toBuffer()],
                program.programId
            );

        vaultAuthorityPDA = vaultAuth;

        const minimumBalanceForRentExemption =
            await provider.connection.getMinimumBalanceForRentExemption(41);

        await program.methods
            .borrow(new anchor.BN(minimumBalanceForRentExemption))
            .accounts({
                activeLoan: activeLoanPDA,
                offerLoan: offerPDA,
                vaultAccount: vaultPDA,
                vaultAssetAccount: vaultAssetAccount,
                vaultAuthority: vaultAuthorityPDA,
                collectionPool: collectionPoolPDA,
                borrower: borrower.publicKey,
                borrowerAssetAccount: borrowerAssetAccount,
                assetMint: assetMint,
                tokenProgram: TOKEN_PROGRAM_ID,
                systemProgram: anchor.web3.SystemProgram.programId,
                clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
            })
            .signers([borrower])
            .rpc();

        const activeLoan = await program.account.activeLoan.fetch(
            activeLoanPDA
        );

        assert.strictEqual(
            activeLoan.borrower.toBase58(),
            borrower.publicKey.toBase58()
        );
        assert.strictEqual(
            activeLoan.collection.toBase58(),
            collectionPoolPDA.toBase58()
        );
        assert.strictEqual(
            activeLoan.lender.toBase58(),
            lender.publicKey.toBase58()
        );
        assert.strictEqual(activeLoan.mint.toBase58(), assetMint.toBase58());
        assert.strictEqual(
            activeLoan.offerAccount.toBase58(),
            offerPDA.toBase58()
        );
        assert.strictEqual(
            activeLoan.repayTs.toNumber(),
            activeLoan.loanTs.toNumber() + loanDuration
        );
        assert.strictEqual(activeLoan.isLiquidated, false);
        assert.strictEqual(activeLoan.isRepaid, false);

        const offerAccount = await program.account.offer.fetch(offerPDA);

        assert.strictEqual(
            offerAccount.borrower.toBase58(),
            borrower.publicKey.toBase58()
        );
        assert.strictEqual(offerAccount.isLoanTaken, true);

        const vaultTokenAccount = await provider.connection.getAccountInfo(
            vaultPDA
        );
        const borrowerAccount = await provider.connection.getAccountInfo(
            borrower.publicKey
        );

        const minimumBalanceForRentExemptionForOfferAccount =
            await provider.connection.getMinimumBalanceForRentExemption(200);

        assert.strictEqual(
            vaultTokenAccount.lamports,
            minimumBalanceForRentExemption
        );
        assert.isAbove(
            borrowerAccount.lamports,
            borrowerInitialBalance +
            offerAmount.toNumber() -
            (minimumBalanceForRentExemption +
                minimumBalanceForRentExemptionForOfferAccount * 2)
        );

        const vaultAssetTokenAccount = await getAccount(
            provider.connection,
            vaultAsset
        );
        const borrowerAssetTokenAccount = await getAccount(
            provider.connection,
            borrowerAssetAccount
        );

        assert.strictEqual(vaultAssetTokenAccount.amount.toString(), "1");
        assert.strictEqual(borrowerAssetTokenAccount.amount.toString(), "0");
    });

    it("Can repay loan", async () => {
        await program.methods
            .repay()
            .accounts({
                activeLoan: activeLoanPDA,
                offer: offerPDA,
                collectionPool: collectionPoolPDA,
                lender: lender.publicKey,
                assetMint: assetMint,
                borrowerAssetAccount: borrowerAssetAccount,
                vaultAssetAccount: vaultAssetAccount,
                vaultAccount: vaultPDA,
                vaultAuthority: vaultAuthorityPDA,
                borrower: borrower.publicKey,
                tokenProgram: TOKEN_PROGRAM_ID,
                systemProgram: anchor.web3.SystemProgram.programId,
            })
            .signers([borrower])
            .rpc();

        const activeLoanAccount = await program.account.activeLoan.fetch(
            activeLoanPDA
        );

        assert.strictEqual(activeLoanAccount.isRepaid, true);

        const borrowerAccount = await provider.connection.getAccountInfo(
            borrower.publicKey
        );
        const lenderAccount = await provider.connection.getAccountInfo(
            lender.publicKey
        );

        assert.approximately(
            borrowerAccount.lamports,
            borrowerInitialBalance,
            0.5 * LAMPORTS_PER_SOL
        );
        assert.approximately(
            lenderAccount.lamports,
            lenderInitialBalance,
            0.5 * LAMPORTS_PER_SOL
        );

        const borrowerAssetTokenAccount = await getAccount(
            provider.connection,
            borrowerAssetAccount
        );
        const vaultAssetTokenAccount = await getAccount(
            provider.connection,
            vaultAssetAccount
        );

        assert.strictEqual(borrowerAssetTokenAccount.amount.toString(), "1");
        assert.strictEqual(vaultAssetTokenAccount.amount.toString(), "0");
    });

    it("Can offer second loan", async () => {
        totalOffers += 1;
        let [offer, _offerBump] = anchor.web3.PublicKey.findProgramAddressSync(
            [
                anchor.utils.bytes.utf8.encode("offer"),
                collectionPoolPDA.toBuffer(),
                lender.publicKey.toBuffer(),
                Buffer.from(totalOffers.toString()),
            ],
            program.programId
        );
        offerPDA = offer;

        let [vault, _vaultBump] = anchor.web3.PublicKey.findProgramAddressSync(
            [
                anchor.utils.bytes.utf8.encode("vault"),
                collectionPoolPDA.toBuffer(),
                lender.publicKey.toBuffer(),
                Buffer.from(totalOffers.toString()),
            ],
            program.programId
        );
        vaultPDA = vault;

        await program.methods
            .offerLoan(offerAmount)
            .accounts({
                offerLoan: offerPDA,
                vaultAccount: vaultPDA,
                collectionPool: collectionPoolPDA,
                lender: lender.publicKey,
                systemProgram: anchor.web3.SystemProgram.programId,
            })
            .signers([lender])
            .rpc();

        const vaultAccount = await provider.connection.getAccountInfo(vaultPDA);
        const lenderAccount = await provider.connection.getAccountInfo(
            lender.publicKey
        );

        assert.approximately(
            vaultAccount.lamports,
            offerAmount.toNumber(),
            0.5 * LAMPORTS_PER_SOL
        );
        assert.approximately(
            lenderAccount.lamports,
            lenderInitialBalance - offerAmount.toNumber(),
            0.5 * LAMPORTS_PER_SOL
        );

        const createdOffer = await program.account.offer.fetch(offerPDA);

        assert.strictEqual(
            createdOffer.collection.toBase58(),
            collectionPoolPDA.toBase58()
        );
        assert.strictEqual(
            createdOffer.offerLamportAmount.toNumber(),
            offerAmount.toNumber()
        );
        assert.strictEqual(
            createdOffer.repayLamportAmount.toNumber(),
            offerAmount.toNumber() + (10 / 100) * offerAmount.toNumber()
        );
        assert.strictEqual(
            createdOffer.lender.toBase58(),
            lender.publicKey.toBase58()
        );
        assert.strictEqual(createdOffer.isLoanTaken, false);
    });

    it("Can borrow second time", async () => {
        let [activeloan, _activeLoanBump] =
            anchor.web3.PublicKey.findProgramAddressSync(
                [
                    anchor.utils.bytes.utf8.encode("active-loan"),
                    offerPDA.toBuffer(),
                ],
                program.programId
            );

        activeLoanPDA = activeloan;

        let [vaultAsset, _vaultAssetBump] =
            anchor.web3.PublicKey.findProgramAddressSync(
                [
                    anchor.utils.bytes.utf8.encode("vault-asset-account"),
                    offerPDA.toBuffer(),
                ],
                program.programId
            );

        vaultAssetAccount = vaultAsset;

        const minimumBalanceForRentExemption =
            await provider.connection.getMinimumBalanceForRentExemption(41);
        await program.methods
            .borrow(new anchor.BN(minimumBalanceForRentExemption))
            .accounts({
                activeLoan: activeLoanPDA,
                offerLoan: offerPDA,
                vaultAccount: vaultPDA,
                vaultAssetAccount: vaultAssetAccount,
                vaultAuthority: vaultAuthorityPDA,
                collectionPool: collectionPoolPDA,
                borrower: borrower.publicKey,
                borrowerAssetAccount: borrowerAssetAccount,
                assetMint: assetMint,
                tokenProgram: TOKEN_PROGRAM_ID,
                systemProgram: anchor.web3.SystemProgram.programId,
                clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
            })
            .signers([borrower])
            .rpc();

        const activeLoan = await program.account.activeLoan.fetch(
            activeLoanPDA
        );

        assert.strictEqual(
            activeLoan.borrower.toBase58(),
            borrower.publicKey.toBase58()
        );
        assert.strictEqual(
            activeLoan.collection.toBase58(),
            collectionPoolPDA.toBase58()
        );
        assert.strictEqual(
            activeLoan.lender.toBase58(),
            lender.publicKey.toBase58()
        );
        assert.strictEqual(activeLoan.mint.toBase58(), assetMint.toBase58());
        assert.strictEqual(
            activeLoan.offerAccount.toBase58(),
            offerPDA.toBase58()
        );
        assert.strictEqual(
            activeLoan.repayTs.toNumber(),
            activeLoan.loanTs.toNumber() + loanDuration
        );
        assert.strictEqual(activeLoan.isLiquidated, false);
        assert.strictEqual(activeLoan.isRepaid, false);

        const offerAccount = await program.account.offer.fetch(offerPDA);

        assert.strictEqual(
            offerAccount.borrower.toBase58(),
            borrower.publicKey.toBase58()
        );
        assert.strictEqual(offerAccount.isLoanTaken, true);

        loanStartTS = activeLoan.loanTs.toNumber();
        loanRepayTS = activeLoan.repayTs.toNumber();

        const vaultTokenAccount = await provider.connection.getAccountInfo(
            vaultPDA
        );
        const borrowerAccount = await provider.connection.getAccountInfo(
            borrower.publicKey
        );

        const minimumBalanceForRentExemptionForOfferAccount =
            await provider.connection.getMinimumBalanceForRentExemption(200);

        assert.strictEqual(
            vaultTokenAccount.lamports,
            minimumBalanceForRentExemption
        );
        assert.approximately(
            borrowerAccount.lamports,
            borrowerInitialBalance +
            offerAmount.toNumber() -
            (minimumBalanceForRentExemption +
                minimumBalanceForRentExemptionForOfferAccount),
            0.5 * LAMPORTS_PER_SOL
        );

        const vaultAssetTokenAccount = await getAccount(
            provider.connection,
            vaultAssetAccount
        );
        const borrowerAssetTokenAccount = await getAccount(
            provider.connection,
            borrowerAssetAccount
        );

        assert.strictEqual(vaultAssetTokenAccount.amount.toString(), "1");
        assert.strictEqual(borrowerAssetTokenAccount.amount.toString(), "0");
    });

    it("Can liquidate loan", async () => {
        if (Date.now() < loanRepayTS * 1000) {
            await sleep(loanRepayTS * 1000 - Date.now() + 3000);
        }

        await program.methods
            .liquidate()
            .accounts({
                activeLoan: activeLoanPDA,
                offer: offerPDA,
                collectionPool: collectionPoolPDA,
                assetMint: assetMint,
                vaultAssetAccount: vaultAssetAccount,
                lenderAssetAccount: lenderAssetAccount,
                lender: lender.publicKey,
                vaultAuthority: vaultAuthorityPDA,
                tokenProgram: TOKEN_PROGRAM_ID,
                clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
            })
            .signers([lender])
            .rpc();

        const activeLoan = await program.account.activeLoan.fetch(
            activeLoanPDA
        );

        assert.strictEqual(activeLoan.isLiquidated, true);

        const lenderAssetTokenAccount = await getAccount(
            provider.connection,
            lenderAssetAccount
        );
        const vaultAssetTokenAccount = await getAccount(
            provider.connection,
            vaultAssetAccount
        );

        assert.strictEqual(lenderAssetTokenAccount.amount.toString(), "1");
        assert.strictEqual(vaultAssetTokenAccount.amount.toString(), "0");
    });

    it("Can offer and withdraw loan", async () => {
        totalOffers += 1;
        let [offer, _offerBump] = anchor.web3.PublicKey.findProgramAddressSync(
            [
                anchor.utils.bytes.utf8.encode("offer"),
                collectionPoolPDA.toBuffer(),
                lender.publicKey.toBuffer(),
                Buffer.from(totalOffers.toString()),
            ],
            program.programId
        );
        offerPDA = offer;

        let [vault, _vaultBump] = anchor.web3.PublicKey.findProgramAddressSync(
            [
                anchor.utils.bytes.utf8.encode("vault"),
                collectionPoolPDA.toBuffer(),
                lender.publicKey.toBuffer(),
                Buffer.from(totalOffers.toString()),
            ],
            program.programId
        );
        vaultPDA = vault;

        await program.methods
            .offerLoan(offerAmount)
            .accounts({
                offerLoan: offerPDA,
                vaultAccount: vaultPDA,
                collectionPool: collectionPoolPDA,
                lender: lender.publicKey,
                systemProgram: anchor.web3.SystemProgram.programId,
            })
            .signers([lender])
            .rpc();

        const createdOffer = await program.account.offer.fetch(offerPDA);

        assert.strictEqual(
            createdOffer.collection.toBase58(),
            collectionPoolPDA.toBase58()
        );
        assert.strictEqual(
            createdOffer.offerLamportAmount.toNumber(),
            offerAmount.toNumber()
        );
        assert.strictEqual(
            createdOffer.repayLamportAmount.toNumber(),
            offerAmount.toNumber() + (10 / 100) * offerAmount.toNumber()
        );
        assert.strictEqual(
            createdOffer.lender.toBase58(),
            lender.publicKey.toBase58()
        );
        assert.strictEqual(createdOffer.isLoanTaken, false);

        const lenderAccountPreWithdraw =
            await provider.connection.getAccountInfo(lender.publicKey);

        assert.approximately(
            lenderAccountPreWithdraw.lamports,
            lenderInitialBalance - 2 * offerAmount.toNumber(),
            0.5 * LAMPORTS_PER_SOL
        );

        const minimumBalanceForRentExemption =
            await provider.connection.getMinimumBalanceForRentExemption(41);

        await program.methods
            .withdrawOffer(
                new anchor.BN(minimumBalanceForRentExemption)
            )
            .accounts({
                offerLoan: offerPDA,
                vaultAccount: vault,
                collectionPool: collectionPoolPDA,
                lender: lender.publicKey,
                systemProgram: anchor.web3.SystemProgram.programId,
            })
            .signers([lender])
            .rpc();

        const lenderAccountPostWithdraw =
            await provider.connection.getAccountInfo(lender.publicKey);

        assert.approximately(
            lenderAccountPostWithdraw.lamports,
            lenderInitialBalance - offerAmount.toNumber(),
            0.5 * LAMPORTS_PER_SOL
        );
    });
});

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
