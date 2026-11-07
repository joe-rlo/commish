//! Test USDC: a NEP-141 token for NEAR testnet demos.
//!
//! - 6 decimals, like USDC. Named "Test USDC" (symbol tUSDC) so nobody mistakes it for the real thing.
//! - `mint` is public and capped at 500 tokens per receiving account per UTC day.
//! - Minting to an account that isn't registered registers it; the caller attaches the
//!   storage deposit (`storage_balance_bounds().min`), and any excess is refunded.
//!
//! Testnet only. It has no owner and no admin methods.

use near_contract_standards::fungible_token::events::FtMint;
use near_contract_standards::fungible_token::metadata::{
    FungibleTokenMetadata, FungibleTokenMetadataProvider, FT_METADATA_SPEC,
};
use near_contract_standards::fungible_token::{FungibleToken, FungibleTokenCore, FungibleTokenResolver};
use near_contract_standards::storage_management::{StorageBalance, StorageBalanceBounds, StorageManagement};
use near_sdk::collections::LazyOption;
use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{
    env, log, near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault, Promise, PromiseOrValue,
};

/// 1 Test USDC in smallest units.
pub const ONE_USDC: u128 = 1_000_000;
/// Mint cap per receiving account per UTC day.
pub const DAILY_MINT_CAP: u128 = 500 * ONE_USDC;
const NS_PER_DAY: u64 = 86_400 * 1_000_000_000;

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Accounts,
    Metadata,
    Minted,
}

#[derive(PanicOnDefault)]
#[near(contract_state)]
pub struct Contract {
    token: FungibleToken,
    metadata: LazyOption<FungibleTokenMetadata>,
    /// Receiver → (UTC day index, amount minted that day).
    minted: LookupMap<AccountId, (u64, u128)>,
}

#[near]
impl Contract {
    #[init]
    pub fn new() -> Self {
        let metadata = FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_string(),
            name: "Test USDC".to_string(),
            symbol: "tUSDC".to_string(),
            icon: None,
            reference: None,
            reference_hash: None,
            decimals: 6,
        };
        metadata.assert_valid();
        Self {
            token: FungibleToken::new(StorageKey::Accounts),
            metadata: LazyOption::new(StorageKey::Metadata, Some(&metadata)),
            minted: LookupMap::new(StorageKey::Minted),
        }
    }

    /// Mints `amount` Test USDC to `account_id`, up to 500 per account per UTC day.
    /// Registers the account first if needed (attach `storage_balance_bounds().min`).
    #[payable]
    pub fn mint(&mut self, account_id: AccountId, amount: U128) -> U128 {
        let amount = amount.0;
        require!(amount > 0, "amount must be above 0");
        let today = env::block_timestamp() / NS_PER_DAY;
        let (day, used) = self.minted.get(&account_id).copied().unwrap_or((today, 0));
        let used = if day == today { used } else { 0 };
        require!(
            used + amount <= DAILY_MINT_CAP,
            format!(
                "Test USDC mint is capped at 500 per account per day; {} left today",
                (DAILY_MINT_CAP - used) as f64 / ONE_USDC as f64
            )
        );

        let mut refund = env::attached_deposit();
        if !self.token.accounts.contains_key(&account_id) {
            let min = self.storage_balance_bounds().min;
            require!(refund >= min, format!("attach {} yoctoNEAR to register {}", min.as_yoctonear(), account_id));
            self.token.internal_register_account(&account_id);
            refund = refund.saturating_sub(min);
        }
        self.token.internal_deposit(&account_id, amount);
        self.minted.insert(account_id.clone(), (today, used + amount));
        FtMint { owner_id: &account_id, amount: U128(amount), memo: Some("test faucet") }.emit();
        if !refund.is_zero() {
            Promise::new(env::predecessor_account_id()).transfer(refund).detach();
        }
        U128(DAILY_MINT_CAP - used - amount)
    }

    /// How much more `account_id` can receive from `mint` today.
    pub fn mint_allowance(&self, account_id: AccountId) -> U128 {
        let today = env::block_timestamp() / NS_PER_DAY;
        match self.minted.get(&account_id) {
            Some((day, used)) if *day == today => U128(DAILY_MINT_CAP - used),
            _ => U128(DAILY_MINT_CAP),
        }
    }
}

#[near]
impl FungibleTokenCore for Contract {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        self.token.ft_transfer(receiver_id, amount, memo)
    }

    #[payable]
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        self.token.ft_transfer_call(receiver_id, amount, memo, msg)
    }

    fn ft_total_supply(&self) -> U128 {
        self.token.ft_total_supply()
    }

    fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        self.token.ft_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenResolver for Contract {
    #[private]
    fn ft_resolve_transfer(&mut self, sender_id: AccountId, receiver_id: AccountId, amount: U128) -> U128 {
        let (used_amount, burned_amount) = self.token.internal_ft_resolve_transfer(&sender_id, receiver_id, amount);
        if burned_amount > 0 {
            log!("Account @{} burned {}", sender_id, burned_amount);
        }
        used_amount.into()
    }
}

#[near]
impl StorageManagement for Contract {
    #[payable]
    fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>) -> StorageBalance {
        self.token.storage_deposit(account_id, registration_only)
    }

    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        self.token.storage_withdraw(amount)
    }

    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        #[allow(unused_variables)]
        if let Some((account_id, balance)) = self.token.internal_storage_unregister(force) {
            log!("Closed @{} with {}", account_id, balance);
            true
        } else {
            false
        }
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.token.storage_balance_bounds()
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.token.storage_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenMetadataProvider for Contract {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        self.metadata.get().unwrap()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::testing_env;

    fn ctx(predecessor: usize, deposit: NearToken, ts: u64) {
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(accounts(predecessor))
            .attached_deposit(deposit)
            .block_timestamp(ts)
            .build());
    }

    #[test]
    fn metadata_is_test_usdc() {
        ctx(0, NearToken::from_yoctonear(0), 0);
        let c = Contract::new();
        let m = c.ft_metadata();
        assert_eq!((m.name.as_str(), m.symbol.as_str(), m.decimals), ("Test USDC", "tUSDC", 6));
    }

    #[test]
    fn mint_registers_and_caps_per_day() {
        ctx(0, NearToken::from_millinear(10), 0);
        let mut c = Contract::new();
        assert_eq!(c.mint(accounts(1), U128(300 * ONE_USDC)).0, 200 * ONE_USDC);
        assert_eq!(c.ft_balance_of(accounts(1)).0, 300 * ONE_USDC);
        ctx(0, NearToken::from_yoctonear(0), 1);
        assert_eq!(c.mint(accounts(1), U128(200 * ONE_USDC)).0, 0);
        assert_eq!(c.mint_allowance(accounts(1)).0, 0);
        // Next UTC day the cap resets.
        ctx(0, NearToken::from_yoctonear(0), NS_PER_DAY);
        assert_eq!(c.mint_allowance(accounts(1)).0, DAILY_MINT_CAP);
        c.mint(accounts(1), U128(500 * ONE_USDC));
        assert_eq!(c.ft_balance_of(accounts(1)).0, 1000 * ONE_USDC);
        assert_eq!(c.ft_total_supply().0, 1000 * ONE_USDC);
    }

    #[test]
    #[should_panic(expected = "capped at 500 per account per day")]
    fn mint_over_cap_fails() {
        ctx(0, NearToken::from_millinear(10), 0);
        let mut c = Contract::new();
        c.mint(accounts(1), U128(500 * ONE_USDC + 1));
    }

    #[test]
    #[should_panic(expected = "to register")]
    fn mint_to_unregistered_needs_storage_deposit() {
        ctx(0, NearToken::from_yoctonear(0), 0);
        let mut c = Contract::new();
        c.mint(accounts(1), U128(ONE_USDC));
    }
}
