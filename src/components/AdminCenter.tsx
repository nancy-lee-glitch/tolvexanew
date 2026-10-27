import React, { useState, useEffect } from 'react';
import type {
  SiteSettings,
  NowPaymentsConfig,
  UserProfile,
  AdminUserItem,
  VipCodeItem,
  PricingPackage,
  BlogPostItem,
  ExternalBrokerConfig,
  BrokersSettings,
  DirectWalletOrder,
  BrokerPlatformItem,
} from '../types.ts';
import {
  getSiteSettings,
  saveSiteSettings,
  fetchRemoteSiteSettings,
  getNowPaymentsConfig,
  saveNowPaymentsConfig,
  fetchRemoteNowPaymentsConfig,
  testNowPaymentsConnection,
  getPricingPackages,
  fetchPricingPackages,
  savePricingPackages,
  fetchAdminUsers,
  grantUserVip,
  revokeUserVip,
  adjustUserCredits,
  fetchAdminVipKeys,
  generateVipKeys,
  toggleVipKey,
  adminTestRedeemVipKey,
  getBrokerConfig,
  saveBrokerConfig,
  fetchRemoteBrokerConfig,
  getBrokersSettings,
  saveBrokersSettings,
  fetchRemoteBrokersSettings,
  getBrokerPlatforms,
  fetchRemoteBrokerPlatforms,
  saveBrokerPlatforms,
  fetchDirectWalletOrders,
  approveDirectWalletOrder,
  rejectDirectWalletOrder,
} from '../utils/siteConfigManager.ts';
import { SupabaseManager } from './SupabaseManager.tsx';
import { SystemFilesViewer } from './SystemFilesViewer.tsx';

export interface AdminCenterProps {
  user?: UserProfile | null;
  onUserUpdated?: (user: UserProfile | null) => void;
  onExitAdmin?: () => void;
  onlineUsers?: number;
}

interface ConfirmDialogState {
  isOpen: boolean;
  title: string;
  message: string;
  actionText?: string;
  variant?: 'amber' | 'emerald' | 'rose';
  onConfirm: () => void;
}

export function AdminCenter({
  user,
  onUserUpdated,
  onExitAdmin,
  onlineUsers = 1,
}: AdminCenterProps) {
  const [activeTab, setActiveTab] = useState<
    'users' | 'vip_codes' | 'pending_orders' | 'pricing' | 'branding' | 'nowpayments' | 'broker' | 'blog' | 'abuse' | 'database' | 'system'
  >('users');

  // Admin Security Gate State
  const [adminIdentity, setAdminIdentity] = useState('durodoluwa5@gmail.com');
  const [adminPasscode, setAdminPasscode] = useState('');
  const [gateLoading, setGateLoading] = useState(false);
  const [gateError, setGateError] = useState<string | null>(null);

  // Global Notification Toast
  const [toastMessage, setToastMessage] = useState<{ text: string; type: 'success' | 'error' | 'info' } | null>(null);

  const showToast = (text: string, type: 'success' | 'error' | 'info' = 'success') => {
    setToastMessage({ text, type });
    setTimeout(() => {
      setToastMessage(null);
    }, 4000);
  };

  // Reusable Confirmation Dialog
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState>({
    isOpen: false,
    title: '',
    message: '',
    onConfirm: () => {},
  });

  const openConfirm = (
    title: string,
    message: string,
    onConfirm: () => void,
    variant: 'amber' | 'emerald' | 'rose' = 'amber',
    actionText = 'Confirm Action'
  ) => {
    setConfirmDialog({
      isOpen: true,
      title,
      message,
      variant,
      actionText,
      onConfirm: () => {
        setConfirmDialog((prev) => ({ ...prev, isOpen: false }));
        onConfirm();
      },
    });
  };

  // =========================================================================
  // TAB 1: USERS DASHBOARD STATE & LOGIC
  // =========================================================================
  const [usersList, setUsersList] = useState<AdminUserItem[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [userFilter, setUserFilter] = useState<'all' | 'vip_active' | 'vip_expired' | 'non_vip' | 'recent'>('all');
  const [actionLoadingId, setActionLoadingId] = useState<string | number | null>(null);

  // Adjust Credits Modal
  const [adjustCreditsModal, setAdjustCreditsModal] = useState<{
    isOpen: boolean;
    user: AdminUserItem | null;
    credits: number;
  }>({
    isOpen: false,
    user: null,
    credits: 0,
  });

  const loadUsers = async () => {
    setUsersLoading(true);
    try {
      const data = await fetchAdminUsers('7789');
      if (Array.isArray(data) && data.length > 0) {
        setUsersList(data);
      } else {
        // Fallback default sample if server returned empty
        setUsersList([
          {
            id: 1,
            username: 'admin',
            email: 'durodoluwa5@gmail.com',
            role: 'ADMIN',
            credits: 9999,
            is_vip: true,
            vip_days_left: 365,
            vip_hours_left: 0,
            vip_expires_at: new Date(Date.now() + 365 * 86400000).toISOString(),
            registration_ip: '127.0.0.1',
            created_at: new Date(Date.now() - 30 * 86400000).toISOString(),
            status: 'active',
          },
        ]);
      }
    } catch (e) {
      console.warn('Failed to load users', e);
    } finally {
      setUsersLoading(false);
    }
  };

  const handleGrantVip = (targetUser: AdminUserItem) => {
    const isCurrentlyVip = Boolean(targetUser.is_vip);
    const msg = isCurrentlyVip
      ? `Trader "${targetUser.username}" already has active VIP. Granting 30 days will EXTEND their access from their current expiry (${targetUser.vip_days_left}d remaining). Continue?`
      : `Grant 30-Day VIP unlimited access to trader "${targetUser.username}" immediately?`;

    openConfirm(
      'Grant 30-Day VIP Pass',
      msg,
      async () => {
        setActionLoadingId(targetUser.id);
        try {
          const res = await grantUserVip(targetUser.id, 30, '7789');
          if (res.success) {
            showToast(res.message || `Granted 30-Day VIP to ${targetUser.username}`, 'success');
            // Refresh users
            await loadUsers();
            if (user && String(user.id) === String(targetUser.id)) {
              onUserUpdated?.({
                ...user,
                is_vip: true,
                vip_days_left: (targetUser.vip_days_left || 0) + 30,
              });
            }
          } else {
            showToast(res.message || 'Failed to grant VIP.', 'error');
          }
        } catch {
          showToast('Network error granting VIP.', 'error');
        } finally {
          setActionLoadingId(null);
        }
      },
      'amber',
      'Grant 30-Day VIP'
    );
  };

  const handleRevokeVip = (targetUser: AdminUserItem) => {
    openConfirm(
      'Revoke VIP Access',
      `Are you sure you want to revoke VIP status from "${targetUser.username}"? They will revert to standard credit deduction.`,
      async () => {
        setActionLoadingId(targetUser.id);
        try {
          const res = await revokeUserVip(targetUser.id, '7789');
          if (res.success) {
            showToast(`Revoked VIP status for ${targetUser.username}`, 'info');
            await loadUsers();
            if (user && String(user.id) === String(targetUser.id)) {
              onUserUpdated?.({
                ...user,
                is_vip: false,
                vip_days_left: 0,
              });
            }
          } else {
            showToast(res.message || 'Failed to revoke VIP.', 'error');
          }
        } catch {
          showToast('Network error revoking VIP.', 'error');
        } finally {
          setActionLoadingId(null);
        }
      },
      'rose',
      'Revoke VIP'
    );
  };

  const handleSaveAdjustCredits = async () => {
    if (!adjustCreditsModal.user) return;
    const target = adjustCreditsModal.user;
    const newCreds = Math.max(0, Number(adjustCreditsModal.credits));
    setActionLoadingId(target.id);
    setAdjustCreditsModal((prev) => ({ ...prev, isOpen: false }));

    try {
      const res = await adjustUserCredits(target.id, newCreds, '7789');
      if (res.success) {
        showToast(`Updated balance for ${target.username} to ${newCreds} CR`, 'success');
        await loadUsers();
        if (user && String(user.id) === String(target.id)) {
          onUserUpdated?.({
            ...user,
            credits: newCreds,
          });
        }
      } else {
        showToast(res.message || 'Failed to adjust credits.', 'error');
      }
    } catch {
      showToast('Network error adjusting credits.', 'error');
    } finally {
      setActionLoadingId(null);
    }
  };

  // Filtered & Sorted Users
  const filteredUsers = usersList
    .filter((u) => {
      // Search
      const q = searchQuery.toLowerCase().trim();
      const matchSearch = !q || u.username.toLowerCase().includes(q) || u.email.toLowerCase().includes(q);
      if (!matchSearch) return false;

      // Filter
      if (userFilter === 'vip_active') return Boolean(u.is_vip);
      if (userFilter === 'vip_expired') return !u.is_vip && Boolean(u.vip_expires_at);
      if (userFilter === 'non_vip') return !u.is_vip;
      if (userFilter === 'recent') {
        const createdTime = u.created_at ? new Date(u.created_at).getTime() : 0;
        return Date.now() - createdTime <= 7 * 86400000;
      }
      return true;
    })
    .sort((a, b) => {
      const timeA = a.created_at ? new Date(a.created_at).getTime() : 0;
      const timeB = b.created_at ? new Date(b.created_at).getTime() : 0;
      return timeB - timeA; // Newest registration first
    });

  const [usersPage, setUsersPage] = useState<number>(1);
  const USERS_PER_PAGE = 15;
  const totalUserPages = Math.max(1, Math.ceil(filteredUsers.length / USERS_PER_PAGE));
  const paginatedUsers = filteredUsers.slice((usersPage - 1) * USERS_PER_PAGE, usersPage * USERS_PER_PAGE);

  // Reset page when filter or search changes
  useEffect(() => {
    setUsersPage(1);
  }, [searchQuery, userFilter]);

  // =========================================================================
  // TAB 2: VIP CODES ENGINE STATE & LOGIC
  // =========================================================================
  const [vipCodesList, setVipCodesList] = useState<VipCodeItem[]>([]);
  const [vipCodesLoading, setVipCodesLoading] = useState(false);
  const [bulkCount, setBulkCount] = useState<number>(5);
  const [bulkDays, setBulkDays] = useState<number>(30);
  const [generatingCodes, setGeneratingCodes] = useState(false);
  const [copiedCode, setCopiedCode] = useState<string | null>(null);

  const loadVipCodes = async () => {
    setVipCodesLoading(true);
    try {
      const data = await fetchAdminVipKeys('7789');
      if (Array.isArray(data) && data.length > 0) {
        setVipCodesList(data);
      } else {
        setVipCodesList((prev) => (prev.length > 0 ? prev : [
          {
            id: 1,
            code: 'PT-VIP-CITADEL30',
            duration_days: 30,
            is_active: true,
            is_redeemed: false,
            created_at: new Date().toISOString(),
          },
          {
            id: 2,
            code: 'PT-VIP-ALPH7789',
            duration_days: 30,
            is_active: true,
            is_redeemed: false,
            created_at: new Date().toISOString(),
          },
        ]));
      }
    } catch (e) {
      console.warn('Failed to load VIP codes', e);
    } finally {
      setVipCodesLoading(false);
    }
  };

  const handleGenerateCodes = async (e: React.FormEvent) => {
    e.preventDefault();
    setGeneratingCodes(true);
    try {
      const count = Math.min(50, Math.max(1, bulkCount));
      const res = await generateVipKeys(count, bulkDays, '7789');
      if (res.success) {
        showToast(res.message || `Generated ${count} one-time VIP codes!`, 'success');
        if (res.keys && res.keys.length > 0) {
          // Prepend immediately to dashboard state
          setVipCodesList((prev) => {
            const existing = new Set(prev.map((c) => c.code.toUpperCase()));
            const toAdd = (res.keys || []).filter((k) => !existing.has(k.code.toUpperCase()));
            return [...toAdd, ...prev];
          });
        }
        await loadVipCodes();
      } else {
        showToast(res.message || 'Failed to generate VIP codes.', 'error');
      }
    } catch {
      showToast('Network error generating codes.', 'error');
    } finally {
      setGeneratingCodes(false);
    }
  };

  const handleToggleCode = (codeItem: VipCodeItem) => {
    const action = codeItem.is_active ? 'Disable' : 'Enable';
    openConfirm(
      `${action} VIP Code`,
      `Are you sure you want to ${action.toLowerCase()} the VIP code "${codeItem.code}"?`,
      async () => {
        try {
          const res = await toggleVipKey(codeItem.id, '7789');
          if (res.success) {
            showToast(`Code "${codeItem.code}" updated.`, 'success');
            await loadVipCodes();
          } else {
            showToast(res.message || 'Failed to update code.', 'error');
          }
        } catch {
          showToast('Network error updating code.', 'error');
        }
      },
      codeItem.is_active ? 'rose' : 'emerald',
      `${action} Code`
    );
  };

  const handleCopyCode = (code: string) => {
    navigator.clipboard.writeText(code);
    setCopiedCode(code);
    showToast(`Copied code "${code}" to clipboard!`, 'info');
    setTimeout(() => setCopiedCode(null), 2500);
  };

  // Admin VIP Code Test Redeem State
  const [testRedeemCode, setTestRedeemCode] = useState('');
  const [testRedeemTarget, setTestRedeemTarget] = useState('');
  const [testRedeemLoading, setTestRedeemLoading] = useState(false);
  const [testRedeemResult, setTestRedeemResult] = useState<{ success: boolean; message: string } | null>(null);

  const handleTestRedeem = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!testRedeemCode.trim() || testRedeemLoading) return;
    setTestRedeemLoading(true);
    setTestRedeemResult(null);
    try {
      const res = await adminTestRedeemVipKey(testRedeemCode.trim(), testRedeemTarget.trim() || 'AdminTestUser');
      setTestRedeemResult(res);
      showToast(res.message, res.success ? 'success' : 'error');
      if (res.success) {
        await loadVipCodes();
        await loadUsers();
      }
    } catch {
      showToast('Network error testing VIP code redeem.', 'error');
    } finally {
      setTestRedeemLoading(false);
    }
  };

  // =========================================================================
  // TAB: DIRECT WALLET ORDERS & PENDING APPROVALS STATE & LOGIC
  // =========================================================================
  const [directOrders, setDirectOrders] = useState<DirectWalletOrder[]>([]);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [orderActionLoading, setOrderActionLoading] = useState<string | null>(null);

  const loadDirectOrders = async () => {
    setOrdersLoading(true);
    try {
      const orders = await fetchDirectWalletOrders();
      setDirectOrders(orders);
    } catch (e) {
      console.warn('Failed to load direct wallet orders', e);
    } finally {
      setOrdersLoading(false);
    }
  };

  const handleApproveOrder = (order: DirectWalletOrder) => {
    openConfirm(
      'Approve Transfer & Grant Package',
      `Verify and approve direct transfer of $${order.amountUsd} (${order.coinSymbol}) for trader "${order.username}"? This will immediately grant ${order.packageType === 'VIP_30' ? '30-Day VIP Pass' : `${order.creditsAmount} Credits`} to their account.`,
      async () => {
        setOrderActionLoading(order.id);
        try {
          const res = await approveDirectWalletOrder(order.id, '7789');
          if (res.success) {
            showToast(res.message, 'success');
            await loadDirectOrders();
            await loadUsers();
          } else {
            showToast(res.message, 'error');
          }
        } catch {
          showToast('Failed to approve transfer', 'error');
        } finally {
          setOrderActionLoading(null);
        }
      },
      'emerald',
      'Approve & Grant'
    );
  };

  const handleRejectOrder = (order: DirectWalletOrder) => {
    openConfirm(
      'Reject Direct Transfer',
      `Reject order "${order.id}" for trader "${order.username}"? No package will be granted.`,
      async () => {
        setOrderActionLoading(order.id);
        try {
          const res = await rejectDirectWalletOrder(order.id, '7789');
          if (res.success) {
            showToast(res.message, 'info');
            await loadDirectOrders();
          } else {
            showToast(res.message, 'error');
          }
        } catch {
          showToast('Failed to reject order', 'error');
        } finally {
          setOrderActionLoading(null);
        }
      },
      'rose',
      'Reject Transfer'
    );
  };

  // Broker Platforms Config State
  const [brokerPlatforms, setBrokerPlatforms] = useState<BrokerPlatformItem[]>(getBrokerPlatforms());
  const [platformsSaving, setPlatformsSaving] = useState(false);

  const loadBrokerPlatforms = async () => {
    try {
      const list = await fetchRemoteBrokerPlatforms();
      setBrokerPlatforms(list);
    } catch (e) {
      console.warn('Failed to load broker platforms', e);
    }
  };

  const handleSaveBrokerPlatforms = async () => {
    setPlatformsSaving(true);
    try {
      const ok = await saveBrokerPlatforms(brokerPlatforms, '7789');
      if (ok) {
        showToast('Broker platforms saved and synced sitewide!', 'success');
      } else {
        showToast('Failed to save broker platforms', 'error');
      }
    } catch {
      showToast('Error saving broker platforms', 'error');
    } finally {
      setPlatformsSaving(false);
    }
  };

  // =========================================================================
  // TAB 3: PRICING PACKAGES STATE & LOGIC
  // =========================================================================
  const [packagesList, setPackagesList] = useState<PricingPackage[]>(getPricingPackages());
  const [packagesSaving, setPackagesSaving] = useState(false);
  const [editingPkg, setEditingPkg] = useState<PricingPackage | null>(null);
  const [isNewPkgModalOpen, setIsNewPkgModalOpen] = useState(false);

  const loadPricingPackages = async () => {
    try {
      const list = await fetchPricingPackages();
      if (Array.isArray(list) && list.length > 0) {
        setPackagesList(list);
      }
    } catch (e) {
      console.warn('Failed to fetch pricing packages', e);
    }
  };

  const handleSaveAllPackages = async (updatedList = packagesList) => {
    setPackagesSaving(true);
    try {
      const res = await savePricingPackages(updatedList, '7789');
      if (res.success) {
        showToast(res.message || 'Pricing packages saved! Changes are live on checkout & pricing views.', 'success');
        setPackagesList(updatedList);
        // Also keep siteSettings in sync if 30-Day VIP price changed
        const vipPkg = updatedList.find((p) => p.type === 'VIP_30_DAY');
        if (vipPkg && vipPkg.price_usd > 0) {
          const updatedSettings = { ...siteSettings, vipPriceUsd: vipPkg.price_usd };
          setSiteSettings(updatedSettings);
          saveSiteSettings(updatedSettings);
        }
      } else {
        showToast(res.message || 'Failed to save packages to server.', 'error');
      }
    } catch (err: any) {
      showToast(err?.message || 'Network error saving packages.', 'error');
    } finally {
      setPackagesSaving(false);
    }
  };

  const handleTogglePackageActive = (id: string | number) => {
    const nextList = packagesList.map((p) => (p.id === id ? { ...p, is_active: !p.is_active } : p));
    setPackagesList(nextList);
    handleSaveAllPackages(nextList);
  };

  const handleDeletePackage = (id: string | number) => {
    openConfirm(
      'Delete Package',
      'Are you sure you want to remove this pricing package from the store?',
      () => {
        const nextList = packagesList.filter((p) => p.id !== id);
        setPackagesList(nextList);
        handleSaveAllPackages(nextList);
      },
      'rose',
      'Delete Package'
    );
  };

  const handleSaveEditedPackage = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingPkg) return;
    const nextList = packagesList.map((p) => (p.id === editingPkg.id ? editingPkg : p));
    setPackagesList(nextList);
    setEditingPkg(null);
    handleSaveAllPackages(nextList);
  };

  const handleCreateNewPackage = (e: React.FormEvent, newPkg: Partial<PricingPackage>) => {
    e.preventDefault();
    const pkgToAdd: PricingPackage = {
      id: `pkg_${Date.now()}`,
      name: newPkg.name || 'New Package',
      type: newPkg.type || 'CREDITS',
      credits_amount: Number(newPkg.credits_amount) || 20,
      bonus_credits: Number(newPkg.bonus_credits) || 0,
      price_usd: Number(newPkg.price_usd) || 15,
      badge_label: newPkg.badge_label || '',
      description: newPkg.description || '',
      is_active: true,
      sort_order: packagesList.length + 1,
    };
    const nextList = [...packagesList, pkgToAdd];
    setPackagesList(nextList);
    setIsNewPkgModalOpen(false);
    handleSaveAllPackages(nextList);
  };

  // =========================================================================
  // TAB 4: BRANDING & PLATFORM CONFIG STATE & LOGIC
  // =========================================================================
  const [siteSettings, setSiteSettings] = useState<SiteSettings>(getSiteSettings());
  const [settingsSaved, setSettingsSaved] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);

  const handleSaveBranding = async (e: React.FormEvent) => {
    e.preventDefault();
    setSettingsSaving(true);
    setSettingsSaved(false);
    try {
      const ok = await saveSiteSettings(siteSettings);
      if (ok) {
        setSettingsSaved(true);
        showToast('Platform branding saved and synced across active trader sessions!', 'success');
        setTimeout(() => setSettingsSaved(false), 3000);
      }
    } finally {
      setSettingsSaving(false);
    }
  };

  const handleLogoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      showToast('Logo image must be smaller than 2MB.', 'error');
      return;
    }
    const reader = new FileReader();
    reader.onload = (ev) => {
      const dataUrl = ev.target?.result as string;
      if (dataUrl) {
        setSiteSettings((prev) => ({ ...prev, logoUrl: dataUrl }));
        showToast('Logo loaded! Click "Save Platform Branding" to apply sitewide.', 'success');
      }
    };
    reader.readAsDataURL(file);
  };

  const handleFaviconUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 1 * 1024 * 1024) {
      showToast('Favicon file must be smaller than 1MB.', 'error');
      return;
    }
    const reader = new FileReader();
    reader.onload = (ev) => {
      const dataUrl = ev.target?.result as string;
      if (dataUrl) {
        setSiteSettings((prev) => ({ ...prev, faviconUrl: dataUrl }));
        showToast('Favicon loaded! Click "Save Platform Branding" to update browser tabs.', 'success');
      }
    };
    reader.readAsDataURL(file);
  };

  // =========================================================================
  // TAB 5: NOWPAYMENTS GATEWAY STATE & LOGIC
  // =========================================================================
  const [nowConfig, setNowConfig] = useState<NowPaymentsConfig>(getNowPaymentsConfig());
  const [nowSaving, setNowSaving] = useState(false);
  const [nowSaved, setNowSaved] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [testingConnection, setTestingConnection] = useState(false);
  const [copiedIpn, setCopiedIpn] = useState(false);

  const handleSaveNowPayments = async (e: React.FormEvent) => {
    e.preventDefault();
    setNowSaving(true);
    setNowSaved(false);
    try {
      const ok = await saveNowPaymentsConfig(nowConfig);
      if (ok) {
        setNowSaved(true);
        showToast('NOWPayments gateway configuration saved successfully!', 'success');
        setTimeout(() => setNowSaved(false), 3000);
      } else {
        showToast('Failed to save NOWPayments config.', 'error');
      }
    } finally {
      setNowSaving(false);
    }
  };

  const handleTestNowPayments = async () => {
    setTestingConnection(true);
    setTestResult(null);
    try {
      const res = await testNowPaymentsConnection(nowConfig.apiKey, nowConfig.isSandbox);
      setTestResult(res);
      showToast(res.message, res.success ? 'success' : 'error');
    } finally {
      setTestingConnection(false);
    }
  };

  const handleCopyIpn = () => {
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    const ipnUrl = `${origin}/api/nowpayments/ipn`;
    navigator.clipboard.writeText(ipnUrl);
    setCopiedIpn(true);
    showToast('IPN Webhook URL copied to clipboard!', 'info');
    setTimeout(() => setCopiedIpn(false), 2000);
  };

  // =========================================================================
  // TAB: BROKER & REFERRAL INTEGRATION STATE & LOGIC
  // =========================================================================
  const [brokersSettings, setBrokersSettings] = useState<BrokersSettings>(getBrokersSettings());
  const [brokerSaving, setBrokerSaving] = useState(false);
  const [brokerSaved, setBrokerSaved] = useState(false);

  useEffect(() => {
    fetchRemoteBrokersSettings().then((cfg) => {
      if (cfg) setBrokersSettings(cfg);
    });
  }, []);

  const handleSaveBrokers = async (e: React.FormEvent) => {
    e.preventDefault();
    setBrokerSaving(true);
    setBrokerSaved(false);
    try {
      const res = await saveBrokersSettings(brokersSettings, '7789');
      if (res.success) {
        setBrokerSaved(true);
        showToast(res.message, 'success');
        setTimeout(() => setBrokerSaved(false), 3000);
      } else {
        showToast(res.message, 'error');
      }
    } catch (err: any) {
      showToast(err?.message || 'Error saving broker settings.', 'error');
    } finally {
      setBrokerSaving(false);
    }
  };

  // =========================================================================
  // TAB 6: BLOG CMS STATE & LOGIC
  // =========================================================================
  const [blogPosts, setBlogPosts] = useState<BlogPostItem[]>([]);
  const [blogLoading, setBlogLoading] = useState(false);
  const [editingPost, setEditingPost] = useState<Partial<BlogPostItem> | null>(null);
  const [isBlogModalOpen, setIsBlogModalOpen] = useState(false);

  const loadBlogPosts = async () => {
    setBlogLoading(true);
    try {
      let res = await fetch('/api/admin/blog/posts');
      if (!res.ok) res = await fetch('/api.php?action=admin_blog_posts');
      if (res.ok) {
        const data = await res.json();
        if (data && Array.isArray(data.posts)) {
          setBlogPosts(data.posts);
        }
      }
    } catch {
      // Fallback
    } finally {
      setBlogLoading(false);
    }
  };

  const handleSaveBlogPost = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingPost || !editingPost.title) return;

    try {
      let res = await fetch('/api/admin/blog/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ post: editingPost, adminPin: '7789' }),
      });
      if (!res.ok) {
        res = await fetch('/api.php?action=admin_save_blog_post', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ post: editingPost, adminPin: '7789' }),
        });
      }
      if (res.ok) {
        showToast('Blog article saved and published!', 'success');
        setIsBlogModalOpen(false);
        setEditingPost(null);
        await loadBlogPosts();
      }
    } catch {
      showToast('Error saving blog article.', 'error');
    }
  };

  // =========================================================================
  // TAB 7: ANTI-ABUSE IP GUARD
  // =========================================================================
  const [ipLimit, setIpLimit] = useState('2');
  const [ipLogs, setIpLogs] = useState([
    { ip: '127.0.0.1', count: 1, lastUser: 'admin', status: 'SAFE' },
    { ip: '192.168.1.45', count: 2, lastUser: 'alpha_whale', status: 'MAX_REACHED' },
    { ip: '10.0.0.88', count: 3, lastUser: 'bot_harvester_9', status: 'BLOCKED' },
  ]);

  const handleResetIp = (ip: string) => {
    setIpLogs((prev) => prev.filter((item) => item.ip !== ip));
    showToast(`IP ${ip} limit reset successfully!`, 'info');
  };

  // Initial Data Bootstrap
  useEffect(() => {
    fetchRemoteSiteSettings().then((s) => setSiteSettings(s));
    fetchRemoteNowPaymentsConfig().then((c) => setNowConfig(c));
    loadUsers();
    loadVipCodes();
    loadPricingPackages();
    loadBlogPosts();
    loadDirectOrders();
    loadBrokerPlatforms();
  }, []);

  const handleAdminGateLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setGateLoading(true);
    setGateError(null);
    try {
      const res = await fetch('/api.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'admin_login',
          identity: adminIdentity.trim(),
          password: adminPasscode.trim(),
        }),
      });
      const data = await res.json();
      if (data.success && data.user) {
        onUserUpdated?.(data.user);
        showToast('Master Admin credentials verified!', 'success');
      } else {
        setGateError(data.message || 'Access Denied: Invalid Master Administrator credentials.');
      }
    } catch (err: any) {
      setGateError(err?.message || 'Authentication kernel unreachable.');
    } finally {
      setGateLoading(false);
    }
  };

  const isMasterAdmin = user?.role === 'ADMIN';

  // -------------------------------------------------------------------------
  // RENDER: Security Gate for Unauthenticated Admins
  // -------------------------------------------------------------------------
  if (!isMasterAdmin) {
    return (
      <div className="max-w-md mx-auto my-12 bg-slate-900 border border-amber-500/30 rounded-3xl p-6 sm:p-8 shadow-2xl space-y-6">
        <div className="text-center space-y-2">
          <div className="w-12 h-12 rounded-2xl bg-amber-500/10 border border-amber-500/30 text-amber-400 flex items-center justify-center mx-auto text-xl font-mono shadow-inner">
            👑
          </div>
          <h2 className="text-lg font-black text-white font-mono uppercase tracking-wide">
            Master Citadel Gate
          </h2>
          <p className="text-xs text-slate-400 font-sans">
            Authentication required to inspect registered users, monetization tiers, and blockchain gateway credentials.
          </p>
        </div>

        {gateError && (
          <div className="p-3 rounded-xl bg-rose-950/60 border border-rose-500/50 text-rose-300 text-xs font-mono flex items-center gap-2">
            <span>⚠️</span>
            <span>{gateError}</span>
          </div>
        )}

        <form onSubmit={handleAdminGateLogin} className="space-y-4">
          <div>
            <label className="text-[10px] text-slate-400 uppercase tracking-wider block font-bold mb-1">
              Admin Identity
            </label>
            <input
              type="text"
              required
              value={adminIdentity}
              onChange={(e) => setAdminIdentity(e.target.value)}
              placeholder="durodoluwa5@gmail.com or admin"
              className="w-full bg-slate-950 border border-slate-800 rounded-xl py-2 px-3 text-xs text-white font-mono focus:border-amber-500 focus:outline-none"
            />
          </div>

          <div>
            <label className="text-[10px] text-slate-400 uppercase tracking-wider block font-bold mb-1">
              Admin Master PIN / Password
            </label>
            <input
              type="password"
              required
              value={adminPasscode}
              onChange={(e) => setAdminPasscode(e.target.value)}
              placeholder="Enter master admin passcode"
              className="w-full bg-slate-950 border border-slate-800 rounded-xl py-2 px-3 text-xs text-white font-mono focus:border-amber-500 focus:outline-none"
            />
          </div>

          <button
            type="submit"
            disabled={gateLoading}
            className="w-full py-3 bg-gradient-to-r from-amber-500 to-amber-400 hover:from-amber-400 hover:to-amber-300 text-slate-950 font-black text-xs uppercase rounded-xl transition shadow-lg shadow-amber-500/20 flex items-center justify-center gap-2 disabled:opacity-50"
          >
            {gateLoading ? 'Verifying Credentials...' : 'Authenticate Master Admin →'}
          </button>
        </form>

        <div className="pt-2 border-t border-slate-800/80 flex items-center justify-between text-xs text-slate-500 font-mono">
          <span>Protected Kernel</span>
          {onExitAdmin && (
            <button type="button" onClick={onExitAdmin} className="text-slate-400 hover:text-white underline">
              Return to Cockpit
            </button>
          )}
        </div>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // RENDER: Full Authorized Master Admin Dashboard
  // -------------------------------------------------------------------------
  return (
    <div className="space-y-5 animate-in fade-in duration-200">
      {/* Toast Notification Banner */}
      {toastMessage && (
        <div
          className={`fixed top-4 right-4 z-50 p-3.5 rounded-2xl border shadow-2xl font-mono text-xs flex items-center gap-2.5 transition-all duration-300 ${
            toastMessage.type === 'success'
              ? 'bg-emerald-950/90 border-emerald-500/60 text-emerald-200 shadow-emerald-900/40'
              : toastMessage.type === 'error'
              ? 'bg-rose-950/90 border-rose-500/60 text-rose-200 shadow-rose-900/40'
              : 'bg-slate-900/90 border-slate-700 text-white shadow-slate-950/60'
          }`}
        >
          <span>{toastMessage.type === 'success' ? '✅' : toastMessage.type === 'error' ? '❌' : 'ℹ️'}</span>
          <span className="font-bold">{toastMessage.text}</span>
        </div>
      )}

      {/* Confirmation Modal */}
      {confirmDialog.isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-in fade-in">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-sm w-full p-5 space-y-4 shadow-2xl">
            <div className="flex items-center gap-2.5 text-white font-bold font-mono text-sm">
              <span className="text-lg">
                {confirmDialog.variant === 'rose' ? '⚠️' : confirmDialog.variant === 'emerald' ? '✓' : '★'}
              </span>
              <span>{confirmDialog.title}</span>
            </div>
            <p className="text-xs text-slate-300 font-sans leading-relaxed">{confirmDialog.message}</p>
            <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-800">
              <button
                type="button"
                onClick={() => setConfirmDialog((prev) => ({ ...prev, isOpen: false }))}
                className="py-1.5 px-3 rounded-lg text-xs font-mono text-slate-400 hover:text-white hover:bg-slate-800 transition"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmDialog.onConfirm}
                className={`py-1.5 px-4 rounded-lg text-xs font-bold font-mono transition shadow ${
                  confirmDialog.variant === 'rose'
                    ? 'bg-rose-600 hover:bg-rose-500 text-white'
                    : confirmDialog.variant === 'emerald'
                    ? 'bg-emerald-500 hover:bg-emerald-400 text-slate-950'
                    : 'bg-amber-500 hover:bg-amber-400 text-slate-950'
                }`}
              >
                {confirmDialog.actionText || 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Adjust Credits Dialog */}
      {adjustCreditsModal.isOpen && adjustCreditsModal.user && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-in fade-in">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-sm w-full p-5 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800 pb-2">
              <div className="font-bold font-mono text-sm text-white">Adjust User Credits</div>
              <button
                type="button"
                onClick={() => setAdjustCreditsModal((prev) => ({ ...prev, isOpen: false }))}
                className="text-slate-400 hover:text-white"
              >
                ✕
              </button>
            </div>
            <div className="space-y-1 text-xs">
              <div className="text-slate-400">
                Trader: <span className="text-white font-bold">{adjustCreditsModal.user.username}</span>
              </div>
              <div className="text-slate-400">
                Current Balance: <span className="text-emerald-400 font-bold">{adjustCreditsModal.user.credits} CR</span>
              </div>
            </div>
            <div>
              <label className="text-[10px] text-slate-400 uppercase tracking-wider block font-bold mb-1">
                New Credit Amount
              </label>
              <input
                type="number"
                min="0"
                value={adjustCreditsModal.credits}
                onChange={(e) =>
                  setAdjustCreditsModal((prev) => ({ ...prev, credits: Number(e.target.value) }))
                }
                className="w-full bg-slate-950 border border-slate-800 rounded-xl py-2 px-3 text-sm text-emerald-400 font-mono font-bold focus:border-emerald-500 focus:outline-none"
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setAdjustCreditsModal((prev) => ({ ...prev, isOpen: false }))}
                className="py-1.5 px-3 text-xs text-slate-400 hover:text-white"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSaveAdjustCredits}
                className="py-1.5 px-4 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs rounded-xl transition"
              >
                Update Balance
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Top Banner & Header */}
      <div className="bg-gradient-to-r from-slate-900 via-slate-900 to-amber-950/40 border border-amber-500/30 rounded-3xl p-4 sm:p-6 shadow-xl flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-amber-400 animate-pulse" />
            <span className="text-xs font-mono font-bold uppercase tracking-wider text-amber-400">
              Citadel Master Control Panel
            </span>
            <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/40">
              ADMIN SECURE
            </span>
          </div>
          <h1 className="text-xl sm:text-2xl font-black text-white font-mono tracking-tight">
            Institutional Operations &amp; Monetization Hub
          </h1>
          <p className="text-xs text-slate-400 max-w-xl">
            Live management of all registered users, 30-day VIP activations, single-use VIP codes, dynamic pricing packages, and NOWPayments crypto gateway.
          </p>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <div className="text-right hidden sm:block font-mono text-xs">
            <div className="text-slate-400">Active Traders Online</div>
            <div className="text-emerald-400 font-bold">{onlineUsers} Global Nodes</div>
          </div>
          {onExitAdmin && (
            <button
              type="button"
              onClick={onExitAdmin}
              className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded-xl text-xs font-mono font-bold transition flex items-center gap-1.5 border border-slate-700"
            >
              <span>← Exit to Cockpit</span>
            </button>
          )}
        </div>
      </div>

      {/* Navigation Tabs Bar */}
      <div className="flex items-center gap-1.5 overflow-x-auto pb-1 border-b border-slate-800 font-mono text-xs">
        {[
          { id: 'users', label: '👥 Registered Users', count: usersList.length },
          { id: 'pending_orders', label: '⏳ Pending Approvals', count: directOrders.filter((o) => o.status === 'pending_admin').length },
          { id: 'vip_codes', label: '🎟️ VIP Codes Engine', count: vipCodesList.length },
          { id: 'pricing', label: '💎 Pricing Packages', count: packagesList.length },
          { id: 'nowpayments', label: '⚡ NOWPayments Gateway' },
          { id: 'broker', label: '🌐 Broker & Referral' },
          { id: 'branding', label: '🎨 Site Branding' },
          { id: 'blog', label: '📰 Blog CMS' },
          { id: 'abuse', label: '🛡️ IP Guard' },
          { id: 'database', label: '🗄️ Database' },
          { id: 'system', label: '⚙️ Diagnostics' },
        ].map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setActiveTab(t.id as any)}
            className={`py-2 px-3 rounded-xl transition whitespace-nowrap flex items-center gap-1.5 ${
              activeTab === t.id
                ? 'bg-amber-500 text-slate-950 font-black shadow-md shadow-amber-500/20'
                : 'text-slate-400 hover:text-white hover:bg-slate-900 font-bold'
            }`}
          >
            <span>{t.label}</span>
            {t.count !== undefined && (
              <span
                className={`text-[10px] px-1.5 py-0.2 rounded-full font-bold ${
                  activeTab === t.id ? 'bg-slate-950 text-amber-300' : 'bg-slate-800 text-slate-300'
                }`}
              >
                {t.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* ========================================================================= */}
      {/* TAB 1: ALL REGISTERED USERS DASHBOARD (REQUIRED)                          */}
      {/* ========================================================================= */}
      {activeTab === 'users' && (
        <div className="space-y-4">
          {/* Controls: Search, Filter, Refresh */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
            <div className="flex-1 flex items-center gap-2 max-w-md">
              <span className="text-slate-500 text-sm">🔍</span>
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search username or email..."
                className="w-full bg-slate-950 border border-slate-800 rounded-xl py-1.5 px-3 text-xs text-white font-mono placeholder:text-slate-600 focus:border-amber-500 focus:outline-none"
              />
            </div>

            <div className="flex items-center gap-2 text-xs font-mono">
              <span className="text-slate-400 hidden md:inline">Filter:</span>
              <select
                value={userFilter}
                onChange={(e) => setUserFilter(e.target.value as any)}
                className="bg-slate-950 border border-slate-800 rounded-xl py-1.5 px-3 text-xs text-slate-200 focus:border-amber-500 focus:outline-none"
              >
                <option value="all">All Users ({usersList.length})</option>
                <option value="vip_active">Active VIP ({usersList.filter((u) => u.is_vip).length})</option>
                <option value="vip_expired">Expired VIP</option>
                <option value="non_vip">Non-VIP Standard</option>
                <option value="recent">Joined Last 7 Days</option>
              </select>

              <button
                type="button"
                onClick={loadUsers}
                disabled={usersLoading}
                className="py-1.5 px-3 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-xl transition flex items-center gap-1.5 disabled:opacity-50"
                title="Refresh users list"
              >
                <span className={usersLoading ? 'animate-spin' : ''}>🔄</span>
                <span>Refresh</span>
              </button>
            </div>
          </div>

          {/* User Table Policy Notice */}
          <div className="bg-amber-950/30 border border-amber-500/30 rounded-xl p-3 text-xs font-mono text-slate-300 flex items-start gap-2.5">
            <span className="text-amber-400 text-base">★</span>
            <div>
              <span className="font-bold text-amber-300">Grant 30-Day VIP Rule: </span>
              <span>
                If the user currently holds active VIP access, granting extends 30 days from their current expiration date.
                If not active VIP, access is granted for exactly 30 calendar days from right now.
              </span>
            </div>
          </div>

          {/* Users Table */}
          <div className="overflow-x-auto border border-slate-800 rounded-2xl bg-slate-900/60 shadow-lg">
            <table className="w-full text-left text-xs font-mono">
              <thead>
                <tr className="border-b border-slate-800 text-slate-400 uppercase text-[10px] bg-slate-950/70">
                  <th className="p-3">ID</th>
                  <th className="p-3">Trader / Email</th>
                  <th className="p-3">Role</th>
                  <th className="p-3">Credits</th>
                  <th className="p-3">VIP Status</th>
                  <th className="p-3">VIP Expiration</th>
                  <th className="p-3">Registration IP</th>
                  <th className="p-3">Joined</th>
                  <th className="p-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/80">
                {paginatedUsers.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="p-8 text-center text-slate-500 font-sans text-xs">
                      No traders found matching your search and filter criteria.
                    </td>
                  </tr>
                ) : (
                  paginatedUsers.map((u) => {
                    const isRowBusy = actionLoadingId === u.id;
                    const isVip = Boolean(u.is_vip);
                    return (
                      <tr key={u.id} className="hover:bg-slate-800/40 transition">
                        <td className="p-3 text-slate-500 font-mono text-[11px]">#{u.id}</td>
                        <td className="p-3">
                          <div className="font-bold text-white flex items-center gap-1.5">
                            <span>{u.username}</span>
                            {u.role === 'ADMIN' && (
                              <span className="text-[9px] bg-amber-500/20 text-amber-300 px-1 py-0.2 rounded border border-amber-500/40">
                                ADMIN
                              </span>
                            )}
                          </div>
                          <div className="text-[11px] text-slate-400">{u.email}</div>
                        </td>
                        <td className="p-3">
                          <span
                            className={`text-[10px] px-2 py-0.5 rounded font-bold ${
                              u.role === 'ADMIN'
                                ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                                : isVip
                                ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                                : 'bg-slate-800 text-slate-400'
                            }`}
                          >
                            {u.role || 'USER'}
                          </span>
                        </td>
                        <td className="p-3 font-bold text-emerald-400">
                          <button
                            type="button"
                            onClick={() =>
                              setAdjustCreditsModal({
                                isOpen: true,
                                user: u,
                                credits: u.credits,
                              })
                            }
                            className="hover:underline flex items-center gap-1"
                            title="Click to adjust credits"
                          >
                            <span>{u.credits} CR</span>
                            <span className="text-[10px] text-slate-500 hover:text-white">✎</span>
                          </button>
                        </td>
                        <td className="p-3">
                          {isVip ? (
                            <span className="bg-amber-500/20 text-amber-300 border border-amber-500/40 px-2 py-0.5 rounded text-[10px] font-bold flex items-center gap-1 w-fit">
                              <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
                              <span>ACTIVE VIP</span>
                            </span>
                          ) : (
                            <span className="bg-slate-800 text-slate-400 px-2 py-0.5 rounded text-[10px]">
                              STANDARD
                            </span>
                          )}
                        </td>
                        <td className="p-3 text-[11px]">
                          {isVip ? (
                            <div>
                              <div className="text-amber-300 font-bold">
                                {u.vip_days_left}d {u.vip_hours_left || 0}h remaining
                              </div>
                              <div className="text-[10px] text-slate-500">
                                {u.vip_expires_at ? new Date(u.vip_expires_at).toLocaleDateString() : 'Active'}
                              </div>
                            </div>
                          ) : (
                            <span className="text-slate-500 text-[10px]">No active pass</span>
                          )}
                        </td>
                        <td className="p-3 text-slate-400 text-[11px] font-mono">
                          {u.registration_ip || '127.0.0.1'}
                        </td>
                        <td className="p-3 text-slate-400 text-[11px]">
                          {u.created_at ? new Date(u.created_at).toLocaleDateString() : 'Recent'}
                        </td>
                        <td className="p-3 text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            <button
                              type="button"
                              disabled={isRowBusy}
                              onClick={() => handleGrantVip(u)}
                              className="py-1 px-2.5 bg-gradient-to-r from-amber-500 to-amber-400 hover:from-amber-400 hover:to-amber-300 text-slate-950 rounded-lg text-[11px] font-bold transition shadow-sm disabled:opacity-50 whitespace-nowrap"
                            >
                              {isRowBusy ? 'Processing...' : isVip ? '+ Extend 30D' : '★ Grant 30-Day VIP'}
                            </button>

                            {isVip && (
                              <button
                                type="button"
                                disabled={isRowBusy}
                                onClick={() => handleRevokeVip(u)}
                                className="py-1 px-2 bg-rose-950/60 hover:bg-rose-900 border border-rose-800 text-rose-300 rounded-lg text-[11px] transition disabled:opacity-50"
                                title="Revoke VIP Access"
                              >
                                Revoke
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {/* Pagination Bar */}
          {totalUserPages > 1 && (
            <div className="flex items-center justify-between text-xs font-mono text-slate-400 pt-2 px-1">
              <div>
                Showing {(usersPage - 1) * USERS_PER_PAGE + 1} to{' '}
                {Math.min(usersPage * USERS_PER_PAGE, filteredUsers.length)} of {filteredUsers.length} traders
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  disabled={usersPage <= 1}
                  onClick={() => setUsersPage((p) => Math.max(1, p - 1))}
                  className="px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-800 hover:bg-slate-800 disabled:opacity-40 transition"
                >
                  ← Previous
                </button>
                <span className="px-2 font-bold text-white">
                  {usersPage} / {totalUserPages}
                </span>
                <button
                  type="button"
                  disabled={usersPage >= totalUserPages}
                  onClick={() => setUsersPage((p) => Math.min(totalUserPages, p + 1))}
                  className="px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-800 hover:bg-slate-800 disabled:opacity-40 transition"
                >
                  Next →
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ========================================================================= */}
      {/* TAB: DIRECT WALLET ORDERS & PENDING APPROVALS                             */}
      {/* ========================================================================= */}
      {activeTab === 'pending_orders' && (
        <div className="space-y-4 font-mono">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-black text-white uppercase tracking-wide flex items-center gap-2">
                <span>⏳ Direct Wallet Deposit Approvals</span>
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/40">
                  {directOrders.filter((o) => o.status === 'pending_admin').length} Pending
                </span>
              </h3>
              <p className="text-xs text-slate-400 font-sans">
                Review proofs for manual USDT / BTC / ETH blockchain transfers. Per strict product rules, passes and credits are ONLY granted once you click Approve.
              </p>
            </div>
            <button
              type="button"
              onClick={loadDirectOrders}
              disabled={ordersLoading}
              className="py-1.5 px-3 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-xl text-xs transition self-start sm:self-auto"
            >
              🔄 Refresh Orders
            </button>
          </div>

          <div className="overflow-x-auto border border-slate-800 rounded-2xl bg-slate-900/60 shadow-lg">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-800 text-slate-400 uppercase text-[10px] bg-slate-950/70">
                  <th className="p-3">Order ID &amp; Time</th>
                  <th className="p-3">Trader</th>
                  <th className="p-3">Package Requested</th>
                  <th className="p-3">Currency &amp; Network</th>
                  <th className="p-3">TXID / Proof</th>
                  <th className="p-3">Status</th>
                  <th className="p-3 text-right">Verification Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/80">
                {directOrders.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="p-8 text-center text-slate-500 font-sans text-xs">
                      No direct wallet orders submitted yet.
                    </td>
                  </tr>
                ) : (
                  directOrders.map((ord) => (
                    <tr key={ord.id} className="hover:bg-slate-800/40 transition">
                      <td className="p-3">
                        <div className="font-bold text-white text-[11px]">{ord.id}</div>
                        <div className="text-[10px] text-slate-500">
                          {new Date(ord.createdAt).toLocaleString()}
                        </div>
                      </td>
                      <td className="p-3">
                        <div className="font-bold text-emerald-400">{ord.username}</div>
                        {ord.userEmail && (
                          <div className="text-[10px] text-slate-500">{ord.userEmail}</div>
                        )}
                      </td>
                      <td className="p-3">
                        <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                          ord.packageType === 'VIP_30'
                            ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                            : 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                        }`}>
                          {ord.packageName} (${ord.amountUsd})
                        </span>
                        <div className="text-[10px] text-slate-400 mt-0.5">
                          {ord.packageType === 'VIP_30' ? '★ 30-Day VIP Pass' : `+${ord.creditsAmount} Credits`}
                        </div>
                      </td>
                      <td className="p-3">
                        <div className="text-white font-bold">{ord.coinSymbol}</div>
                        <div className="text-[10px] text-slate-500">{ord.network}</div>
                      </td>
                      <td className="p-3 max-w-[200px]">
                        <div className="truncate text-slate-300 font-mono text-[10px] bg-slate-950 p-1 rounded border border-slate-800" title={ord.txHash}>
                          {ord.txHash}
                        </div>
                        <div className="text-[9px] text-slate-500 mt-0.5 truncate" title={ord.depositAddress}>
                          Deposit: {ord.depositAddress}
                        </div>
                      </td>
                      <td className="p-3">
                        {ord.status === 'pending_admin' && (
                          <span className="bg-amber-500/20 text-amber-300 border border-amber-500/40 px-2 py-0.5 rounded text-[10px] font-bold animate-pulse">
                            PENDING APPROVAL
                          </span>
                        )}
                        {ord.status === 'approved' && (
                          <span className="bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 px-2 py-0.5 rounded text-[10px] font-bold">
                            APPROVED &amp; GRANTED
                          </span>
                        )}
                        {ord.status === 'rejected' && (
                          <span className="bg-rose-500/20 text-rose-300 border border-rose-500/40 px-2 py-0.5 rounded text-[10px] font-bold">
                            REJECTED
                          </span>
                        )}
                      </td>
                      <td className="p-3 text-right">
                        {ord.status === 'pending_admin' ? (
                          <div className="flex items-center justify-end gap-1.5">
                            <button
                              type="button"
                              disabled={orderActionLoading === ord.id}
                              onClick={() => handleApproveOrder(ord)}
                              className="py-1 px-3 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold rounded-lg text-[11px] transition shadow"
                            >
                              Approve
                            </button>
                            <button
                              type="button"
                              disabled={orderActionLoading === ord.id}
                              onClick={() => handleRejectOrder(ord)}
                              className="py-1 px-2.5 bg-rose-950 hover:bg-rose-900 border border-rose-800 text-rose-300 font-bold rounded-lg text-[11px] transition"
                            >
                              Reject
                            </button>
                          </div>
                        ) : (
                          <span className="text-[10px] text-slate-500">
                            {ord.processedAt ? new Date(ord.processedAt).toLocaleDateString() : 'Processed'}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* TAB 2: VIP CODES ENGINE (ONE-TIME SECURE SYSTEM)                          */}
      {/* ========================================================================= */}
      {activeTab === 'vip_codes' && (
        <div className="space-y-4 font-mono">
          {/* Code Generator Bar */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 sm:p-5 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-800 pb-3">
              <div>
                <h3 className="text-sm font-black text-white uppercase tracking-wide flex items-center gap-2">
                  <span>🎟️ Cryptographic VIP Code Generator</span>
                </h3>
                <p className="text-xs text-slate-400 font-sans">
                  Generate secure, unpredictable, single-use activation codes (e.g. <code>PT-VIP-XXXXXXXX</code>).
                  Each code can be redeemed exactly once by a single user.
                </p>
              </div>
              <button
                type="button"
                onClick={loadVipCodes}
                disabled={vipCodesLoading}
                className="py-1.5 px-3 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-xl text-xs transition"
              >
                🔄 Refresh Codes
              </button>
            </div>

            <form onSubmit={handleGenerateCodes} className="flex flex-wrap items-end gap-3 text-xs">
              <div>
                <label className="text-[10px] text-slate-400 uppercase tracking-wider block font-bold mb-1">
                  Quantity (1–50)
                </label>
                <input
                  type="number"
                  min="1"
                  max="50"
                  value={bulkCount}
                  onChange={(e) => setBulkCount(Number(e.target.value))}
                  className="bg-slate-950 border border-slate-800 rounded-xl py-2 px-3 text-white font-bold w-28 focus:border-amber-500 focus:outline-none"
                />
              </div>

              <div>
                <label className="text-[10px] text-slate-400 uppercase tracking-wider block font-bold mb-1">
                  Duration (Days)
                </label>
                <input
                  type="number"
                  min="1"
                  value={bulkDays}
                  onChange={(e) => setBulkDays(Number(e.target.value))}
                  className="bg-slate-950 border border-slate-800 rounded-xl py-2 px-3 text-white font-bold w-28 focus:border-amber-500 focus:outline-none"
                />
              </div>

              <button
                type="submit"
                disabled={generatingCodes}
                className="py-2 px-5 bg-gradient-to-r from-amber-500 to-amber-400 hover:from-amber-400 hover:to-amber-300 text-slate-950 font-black text-xs uppercase rounded-xl transition shadow-lg shadow-amber-500/20 disabled:opacity-50"
              >
                {generatingCodes ? 'Generating...' : `⚡ Generate ${bulkCount} Secure Codes`}
              </button>
            </form>

            {/* Test Redeem Tool */}
            <div className="pt-3 border-t border-slate-800/80">
              <span className="text-[10px] text-slate-400 uppercase tracking-wider block font-bold mb-2">
                🧪 Live Activation Code Test Redeem (Admin Diagnostic)
              </span>
              <form onSubmit={handleTestRedeem} className="flex flex-wrap items-center gap-2 text-xs">
                <input
                  type="text"
                  placeholder="Paste activation code (e.g. PT-VIP-...)"
                  value={testRedeemCode}
                  onChange={(e) => setTestRedeemCode(e.target.value)}
                  className="bg-slate-950 border border-slate-800 rounded-xl py-2 px-3 text-white focus:border-emerald-500 focus:outline-none font-mono text-xs w-60"
                />
                <input
                  type="text"
                  placeholder="Target username/email"
                  value={testRedeemTarget}
                  onChange={(e) => setTestRedeemTarget(e.target.value)}
                  className="bg-slate-950 border border-slate-800 rounded-xl py-2 px-3 text-white focus:border-emerald-500 focus:outline-none text-xs w-52"
                />
                <button
                  type="submit"
                  disabled={testRedeemLoading || !testRedeemCode.trim()}
                  className="py-2 px-4 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-emerald-400 border border-emerald-500/30 rounded-xl font-bold transition text-xs"
                >
                  {testRedeemLoading ? 'Testing...' : 'Test Redeem'}
                </button>
              </form>
              {testRedeemResult && (
                <div className={`mt-2 p-2 rounded-lg text-xs font-mono flex items-center gap-2 ${
                  testRedeemResult.success
                    ? 'bg-emerald-950/60 text-emerald-300 border border-emerald-500/40'
                    : 'bg-rose-950/60 text-rose-300 border border-rose-500/40'
                }`}>
                  <span>{testRedeemResult.success ? '✅' : '❌'}</span>
                  <span>{testRedeemResult.message}</span>
                </div>
              )}
            </div>
          </div>

          {/* VIP Codes Table */}
          <div className="overflow-x-auto border border-slate-800 rounded-2xl bg-slate-900/60 shadow-lg">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-800 text-slate-400 uppercase text-[10px] bg-slate-950/70">
                  <th className="p-3">Activation Code</th>
                  <th className="p-3">Duration</th>
                  <th className="p-3">Status</th>
                  <th className="p-3">Usage</th>
                  <th className="p-3">Redeemed By</th>
                  <th className="p-3">Created</th>
                  <th className="p-3 text-right">Controls</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/80">
                {vipCodesList.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="p-8 text-center text-slate-500 font-sans text-xs">
                      No VIP codes generated yet. Use the generator above to create secure passes.
                    </td>
                  </tr>
                ) : (
                  vipCodesList.map((c) => {
                    const isCopied = copiedCode === c.code;
                    return (
                      <tr key={c.id} className="hover:bg-slate-800/40 transition">
                        <td className="p-3">
                          <div className="flex items-center gap-2">
                            <span className="font-bold text-amber-300 bg-slate-950 border border-slate-800 px-2 py-1 rounded-lg">
                              {c.code}
                            </span>
                            <button
                              type="button"
                              onClick={() => handleCopyCode(c.code)}
                              className="text-[11px] text-slate-400 hover:text-white bg-slate-800 hover:bg-slate-700 px-2 py-0.5 rounded transition"
                            >
                              {isCopied ? 'Copied!' : 'Copy'}
                            </button>
                          </div>
                        </td>
                        <td className="p-3 text-white font-bold">{c.duration_days} Days</td>
                        <td className="p-3">
                          {c.is_redeemed ? (
                            <span className="bg-slate-800 text-slate-400 px-2 py-0.5 rounded text-[10px] font-bold">
                              REDEEMED
                            </span>
                          ) : c.is_active ? (
                            <span className="bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 px-2 py-0.5 rounded text-[10px] font-bold">
                              UNUSED (ACTIVE)
                            </span>
                          ) : (
                            <span className="bg-rose-500/20 text-rose-300 border border-rose-500/40 px-2 py-0.5 rounded text-[10px] font-bold">
                              DISABLED
                            </span>
                          )}
                        </td>
                        <td className="p-3 text-slate-400 text-[11px]">
                          {c.is_redeemed ? '1 / 1 (Max)' : '0 / 1 (Single-Use)'}
                        </td>
                        <td className="p-3 text-slate-300 text-[11px]">
                          {c.redeemed_by_username ? (
                            <div>
                              <div className="font-bold text-emerald-400">{c.redeemed_by_username}</div>
                              <div className="text-[10px] text-slate-500">
                                {c.redeemed_at ? new Date(c.redeemed_at).toLocaleDateString() : ''}
                              </div>
                            </div>
                          ) : (
                            <span className="text-slate-500 text-[10px]">—</span>
                          )}
                        </td>
                        <td className="p-3 text-slate-400 text-[11px]">
                          {c.created_at ? new Date(c.created_at).toLocaleDateString() : 'System'}
                        </td>
                        <td className="p-3 text-right">
                          {!c.is_redeemed && (
                            <button
                              type="button"
                              onClick={() => handleToggleCode(c)}
                              className={`py-1 px-2.5 rounded-lg text-[11px] font-bold transition ${
                                c.is_active
                                  ? 'bg-rose-950/60 hover:bg-rose-900 border border-rose-800 text-rose-300'
                                  : 'bg-emerald-950/60 hover:bg-emerald-900 border border-emerald-800 text-emerald-300'
                              }`}
                            >
                              {c.is_active ? 'Disable' : 'Activate'}
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* TAB 3: PRICING PACKAGES (ADMIN-EDITABLE)                                  */}
      {/* ========================================================================= */}
      {activeTab === 'pricing' && (
        <div className="space-y-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-black text-white font-mono uppercase tracking-wide">
                💎 Monetization &amp; Pricing Packages
              </h3>
              <p className="text-xs text-slate-400 font-sans">
                Manage credit bundles and VIP access packages shown on the public checkout and landing page.
                Price updates reflect immediately on all client views without hardcoded constants.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setIsNewPkgModalOpen(true)}
                className="py-2 px-4 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs rounded-xl transition shadow"
              >
                + Add Package
              </button>
              <button
                type="button"
                disabled={packagesSaving}
                onClick={() => handleSaveAllPackages()}
                className="py-2 px-4 bg-amber-500 hover:bg-amber-400 text-slate-950 font-black text-xs rounded-xl transition shadow disabled:opacity-50"
              >
                {packagesSaving ? 'Saving...' : '💾 Save Packages'}
              </button>
            </div>
          </div>

          {/* Packages Card Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-xs font-mono">
            {packagesList.map((pkg) => (
              <div
                key={pkg.id}
                className={`border rounded-2xl p-4 space-y-3 relative transition ${
                  pkg.is_active
                    ? pkg.type === 'VIP_30_DAY'
                      ? 'bg-amber-950/20 border-amber-500/50 shadow-lg shadow-amber-950/20'
                      : 'bg-slate-900 border-slate-800'
                    : 'bg-slate-950/60 border-slate-800/60 opacity-60'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span
                    className={`text-[10px] px-2 py-0.5 rounded font-bold uppercase ${
                      pkg.type === 'VIP_30_DAY'
                        ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                        : 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                    }`}
                  >
                    {pkg.type}
                  </span>
                  <button
                    type="button"
                    onClick={() => handleTogglePackageActive(pkg.id)}
                    className={`text-[10px] px-2 py-0.5 rounded font-bold transition ${
                      pkg.is_active
                        ? 'bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30'
                        : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
                    }`}
                  >
                    {pkg.is_active ? '● ACTIVE' : '○ DISABLED'}
                  </button>
                </div>

                <div>
                  <div className="font-bold text-white text-sm">{pkg.name}</div>
                  <div className="text-xl font-black text-white mt-1">${pkg.price_usd}.00</div>
                  <div className="text-[11px] text-slate-400 mt-0.5">
                    {pkg.type === 'VIP_30_DAY'
                      ? 'Strict 30-Day Unlimited Access'
                      : `${pkg.credits_amount} Credits ${pkg.bonus_credits ? `+ ${pkg.bonus_credits} Bonus` : ''}`}
                  </div>
                </div>

                {pkg.badge_label && (
                  <div className="text-[10px] text-amber-300 bg-amber-500/10 border border-amber-500/30 px-2 py-0.5 rounded w-fit">
                    {pkg.badge_label}
                  </div>
                )}

                <div className="flex items-center justify-between pt-2 border-t border-slate-800/80">
                  <button
                    type="button"
                    onClick={() => setEditingPkg(pkg)}
                    className="text-amber-400 hover:text-amber-300 text-xs font-bold"
                  >
                    ✎ Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDeletePackage(pkg.id)}
                    className="text-rose-400 hover:text-rose-300 text-xs"
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>

          {/* Edit Package Modal */}
          {editingPkg && (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-in fade-in">
              <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-md w-full p-5 space-y-4 shadow-2xl font-mono text-xs">
                <div className="flex items-center justify-between border-b border-slate-800 pb-2">
                  <div className="font-bold text-sm text-white">Edit Package: {editingPkg.name}</div>
                  <button type="button" onClick={() => setEditingPkg(null)} className="text-slate-400 hover:text-white">
                    ✕
                  </button>
                </div>

                <form onSubmit={handleSaveEditedPackage} className="space-y-3">
                  <div>
                    <label className="text-[10px] text-slate-400 uppercase tracking-wider block font-bold mb-1">
                      Package Name
                    </label>
                    <input
                      type="text"
                      required
                      value={editingPkg.name}
                      onChange={(e) => setEditingPkg({ ...editingPkg, name: e.target.value })}
                      className="w-full bg-slate-950 border border-slate-800 rounded-xl py-2 px-3 text-white focus:border-amber-500 focus:outline-none"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-[10px] text-slate-400 uppercase tracking-wider block font-bold mb-1">
                        Price (USD $)
                      </label>
                      <input
                        type="number"
                        min="1"
                        required
                        value={editingPkg.price_usd}
                        onChange={(e) => setEditingPkg({ ...editingPkg, price_usd: Number(e.target.value) })}
                        className="w-full bg-slate-950 border border-slate-800 rounded-xl py-2 px-3 text-white focus:border-amber-500 focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] text-slate-400 uppercase tracking-wider block font-bold mb-1">
                        Package Type
                      </label>
                      <select
                        value={editingPkg.type}
                        onChange={(e) => setEditingPkg({ ...editingPkg, type: e.target.value as any })}
                        className="w-full bg-slate-950 border border-slate-800 rounded-xl py-2 px-3 text-white focus:border-amber-500 focus:outline-none"
                      >
                        <option value="CREDITS">CREDITS</option>
                        <option value="VIP_30_DAY">VIP_30_DAY</option>
                        <option value="BUNDLE">BUNDLE</option>
                      </select>
                    </div>
                  </div>

                  {editingPkg.type !== 'VIP_30_DAY' && (
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="text-[10px] text-slate-400 uppercase tracking-wider block font-bold mb-1">
                          Base Credits
                        </label>
                        <input
                          type="number"
                          min="0"
                          value={editingPkg.credits_amount}
                          onChange={(e) => setEditingPkg({ ...editingPkg, credits_amount: Number(e.target.value) })}
                          className="w-full bg-slate-950 border border-slate-800 rounded-xl py-2 px-3 text-white focus:border-amber-500 focus:outline-none"
                        />
                      </div>
                      <div>
                        <label className="text-[10px] text-slate-400 uppercase tracking-wider block font-bold mb-1">
                          Bonus Credits
                        </label>
                        <input
                          type="number"
                          min="0"
                          value={editingPkg.bonus_credits}
                          onChange={(e) => setEditingPkg({ ...editingPkg, bonus_credits: Number(e.target.value) })}
                          className="w-full bg-slate-950 border border-slate-800 rounded-xl py-2 px-3 text-white focus:border-amber-500 focus:outline-none"
                        />
                      </div>
                    </div>
                  )}

                  <div>
                    <label className="text-[10px] text-slate-400 uppercase tracking-wider block font-bold mb-1">
                      Badge Label (Optional)
                    </label>
                    <input
                      type="text"
                      value={editingPkg.badge_label || ''}
                      onChange={(e) => setEditingPkg({ ...editingPkg, badge_label: e.target.value })}
                      placeholder="e.g. Popular, Best Value"
                      className="w-full bg-slate-950 border border-slate-800 rounded-xl py-2 px-3 text-white focus:border-amber-500 focus:outline-none"
                    />
                  </div>

                  <div>
                    <label className="text-[10px] text-slate-400 uppercase tracking-wider block font-bold mb-1">
                      Description
                    </label>
                    <textarea
                      rows={2}
                      value={editingPkg.description || ''}
                      onChange={(e) => setEditingPkg({ ...editingPkg, description: e.target.value })}
                      className="w-full bg-slate-950 border border-slate-800 rounded-xl py-2 px-3 text-white font-sans focus:border-amber-500 focus:outline-none"
                    />
                  </div>

                  <div className="flex justify-end gap-2 pt-2">
                    <button
                      type="button"
                      onClick={() => setEditingPkg(null)}
                      className="py-1.5 px-3 text-slate-400 hover:text-white"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      className="py-2 px-5 bg-amber-500 hover:bg-amber-400 text-slate-950 font-black rounded-xl transition"
                    >
                      Save Package Changes
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}

          {/* Add New Package Modal */}
          {isNewPkgModalOpen && (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-in fade-in">
              <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-md w-full p-5 space-y-4 shadow-2xl font-mono text-xs">
                <div className="flex items-center justify-between border-b border-slate-800 pb-2">
                  <div className="font-bold text-sm text-white">Create New Pricing Package</div>
                  <button
                    type="button"
                    onClick={() => setIsNewPkgModalOpen(false)}
                    className="text-slate-400 hover:text-white"
                  >
                    ✕
                  </button>
                </div>

                <form
                  onSubmit={(e) => {
                    const form = e.target as any;
                    handleCreateNewPackage(e, {
                      name: form.name.value,
                      type: form.type.value,
                      price_usd: Number(form.price_usd.value),
                      credits_amount: Number(form.credits_amount?.value || 0),
                      bonus_credits: Number(form.bonus_credits?.value || 0),
                      badge_label: form.badge_label.value,
                      description: form.description.value,
                    });
                  }}
                  className="space-y-3"
                >
                  <div>
                    <label className="text-[10px] text-slate-400 uppercase tracking-wider block font-bold mb-1">
                      Package Name
                    </label>
                    <input
                      name="name"
                      type="text"
                      required
                      placeholder="e.g. VIP 60-Day Ultra Pass"
                      className="w-full bg-slate-950 border border-slate-800 rounded-xl py-2 px-3 text-white focus:border-amber-500 focus:outline-none"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-[10px] text-slate-400 uppercase tracking-wider block font-bold mb-1">
                        Price (USD $)
                      </label>
                      <input
                        name="price_usd"
                        type="number"
                        min="1"
                        required
                        defaultValue="29"
                        className="w-full bg-slate-950 border border-slate-800 rounded-xl py-2 px-3 text-white focus:border-amber-500 focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] text-slate-400 uppercase tracking-wider block font-bold mb-1">
                        Type
                      </label>
                      <select
                        name="type"
                        defaultValue="CREDITS"
                        className="w-full bg-slate-950 border border-slate-800 rounded-xl py-2 px-3 text-white focus:border-amber-500 focus:outline-none"
                      >
                        <option value="CREDITS">CREDITS</option>
                        <option value="VIP_30_DAY">VIP_30_DAY</option>
                        <option value="BUNDLE">BUNDLE</option>
                      </select>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-[10px] text-slate-400 uppercase tracking-wider block font-bold mb-1">
                        Base Credits
                      </label>
                      <input
                        name="credits_amount"
                        type="number"
                        min="0"
                        defaultValue="50"
                        className="w-full bg-slate-950 border border-slate-800 rounded-xl py-2 px-3 text-white focus:border-amber-500 focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] text-slate-400 uppercase tracking-wider block font-bold mb-1">
                        Bonus Credits
                      </label>
                      <input
                        name="bonus_credits"
                        type="number"
                        min="0"
                        defaultValue="10"
                        className="w-full bg-slate-950 border border-slate-800 rounded-xl py-2 px-3 text-white focus:border-amber-500 focus:outline-none"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="text-[10px] text-slate-400 uppercase tracking-wider block font-bold mb-1">
                      Badge Label
                    </label>
                    <input
                      name="badge_label"
                      type="text"
                      placeholder="e.g. Best Value"
                      className="w-full bg-slate-950 border border-slate-800 rounded-xl py-2 px-3 text-white focus:border-amber-500 focus:outline-none"
                    />
                  </div>

                  <div>
                    <label className="text-[10px] text-slate-400 uppercase tracking-wider block font-bold mb-1">
                      Description
                    </label>
                    <textarea
                      name="description"
                      rows={2}
                      placeholder="Description of benefits"
                      className="w-full bg-slate-950 border border-slate-800 rounded-xl py-2 px-3 text-white font-sans focus:border-amber-500 focus:outline-none"
                    />
                  </div>

                  <div className="flex justify-end gap-2 pt-2">
                    <button
                      type="button"
                      onClick={() => setIsNewPkgModalOpen(false)}
                      className="py-1.5 px-3 text-slate-400 hover:text-white"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      className="py-2 px-5 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black rounded-xl transition"
                    >
                      Create Package
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ========================================================================= */}
      {/* TAB 4: NOWPAYMENTS GATEWAY & AUTOMATED VERIFICATION                       */}
      {/* ========================================================================= */}
      {activeTab === 'nowpayments' && (
        <form onSubmit={handleSaveNowPayments} className="space-y-4">
          <div className="bg-emerald-950/30 border border-emerald-500/40 rounded-xl p-4 text-xs space-y-2">
            <div className="flex items-center justify-between">
              <div className="font-black text-emerald-400 flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse" />
                <span>NOWPayments Instant Automated Crypto Engine</span>
              </div>
              <span
                className={`text-[10px] px-2 py-0.5 rounded font-bold uppercase ${
                  nowConfig.enabled
                    ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                    : 'bg-slate-800 text-slate-400 border border-slate-700'
                }`}
              >
                {nowConfig.enabled ? '● GATEWAY ACTIVE' : '○ DISABLED'}
              </span>
            </div>
            <p className="text-slate-300 text-[11px] leading-relaxed">
              When enabled, traders receive a direct crypto deposit invoice supporting USDT TRC-20, BEP-20, BTC, ETH, TON, and LTC.
              When blockchain confirmation completes, NOWPayments fires an Instant Payment Notification (IPN), and the user's <strong>30-Day VIP Pass</strong> or credit package is credited automatically with idempotency protection.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1 sm:col-span-2 bg-slate-950 border border-slate-800 p-3.5 rounded-xl flex items-center justify-between">
              <div>
                <div className="text-xs font-bold text-white">Enable NOWPayments Gateway in Checkout</div>
                <div className="text-[10px] text-slate-400">
                  Allows traders to buy credits and 30-Day VIP directly using crypto.
                </div>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={nowConfig.enabled}
                  onChange={(e) => setNowConfig({ ...nowConfig, enabled: e.target.checked })}
                  className="sr-only peer"
                />
                <div className="w-11 h-6 bg-slate-800 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-emerald-500"></div>
              </label>
            </div>

            <div className="space-y-1.5 sm:col-span-2">
              <label className="text-[10px] text-slate-400 uppercase tracking-wider block font-bold">
                NOWPayments Production / Sandbox API Key
              </label>
              <input
                type="text"
                value={nowConfig.apiKey}
                onChange={(e) => setNowConfig({ ...nowConfig, apiKey: e.target.value })}
                placeholder="e.g. 7X89-ABCDEF-GHIJKL-MNOPQR"
                className="w-full bg-slate-950 border border-slate-800 rounded-xl py-2 px-3 text-xs text-white font-mono focus:border-emerald-500 focus:outline-none"
              />
              <span className="text-[10px] text-slate-500">
                Obtain this from your account at{' '}
                <a href="https://account.nowpayments.io/store-settings" target="_blank" rel="noreferrer" className="text-emerald-400 hover:underline">
                  account.nowpayments.io &rarr; Store Settings
                </a>
              </span>
            </div>

            <div className="space-y-1.5 sm:col-span-2">
              <label className="text-[10px] text-slate-400 uppercase tracking-wider block font-bold">
                NOWPayments IPN Secret Key (Webhook Verification)
              </label>
              <input
                type="password"
                value={nowConfig.ipnSecret}
                onChange={(e) => setNowConfig({ ...nowConfig, ipnSecret: e.target.value })}
                placeholder="HMAC SHA-512 verification secret"
                className="w-full bg-slate-950 border border-slate-800 rounded-xl py-2 px-3 text-xs text-white font-mono focus:border-emerald-500 focus:outline-none"
              />
            </div>

            <div className="space-y-1.5 bg-slate-950 border border-slate-800 p-3 rounded-xl">
              <label className="text-[10px] text-slate-400 uppercase tracking-wider block font-bold mb-1">
                API Environment Mode
              </label>
              <div className="flex items-center gap-4 text-xs font-mono">
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="radio"
                    name="nowpayments_mode"
                    checked={!nowConfig.isSandbox}
                    onChange={() => setNowConfig({ ...nowConfig, isSandbox: false })}
                    className="text-emerald-500 focus:ring-emerald-500"
                  />
                  <span className="text-white font-bold">Live Production</span>
                </label>
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="radio"
                    name="nowpayments_mode"
                    checked={nowConfig.isSandbox}
                    onChange={() => setNowConfig({ ...nowConfig, isSandbox: true })}
                    className="text-amber-500 focus:ring-amber-500"
                  />
                  <span className="text-amber-400">Sandbox Testing</span>
                </label>
              </div>
            </div>

            <div className="space-y-1.5 bg-slate-950 border border-slate-800 p-3 rounded-xl font-mono">
              <label className="text-[10px] text-slate-400 uppercase tracking-wider block font-bold mb-1">
                Instant IPN Webhook URL
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  readOnly
                  value={`${typeof window !== 'undefined' ? window.location.origin : ''}/api/nowpayments/ipn`}
                  className="w-full bg-slate-900 border border-slate-800 rounded-lg py-1 px-2 text-[11px] text-slate-300 font-mono"
                />
                <button
                  type="button"
                  onClick={handleCopyIpn}
                  className="text-xs bg-slate-800 hover:bg-slate-700 text-white px-3 py-1 rounded-lg transition whitespace-nowrap"
                >
                  {copiedIpn ? 'Copied!' : 'Copy'}
                </button>
              </div>
            </div>
          </div>

          <div className="bg-slate-950 border border-slate-800/80 rounded-xl p-3.5 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs text-slate-400">Ping NOWPayments API:</span>
              <button
                type="button"
                onClick={handleTestNowPayments}
                disabled={testingConnection || !nowConfig.apiKey}
                className="py-1.5 px-3 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-emerald-400 border border-emerald-500/30 rounded-lg text-xs font-bold transition flex items-center gap-1.5"
              >
                {testingConnection ? 'Pinging API...' : '⚡ Test API Connection'}
              </button>
            </div>

            {testResult && (
              <div
                className={`p-2.5 rounded-lg text-xs font-mono flex items-center gap-2 ${
                  testResult.success
                    ? 'bg-emerald-950/60 text-emerald-300 border border-emerald-500/40'
                    : 'bg-rose-950/60 text-rose-300 border border-rose-500/40'
                }`}
              >
                <span>{testResult.success ? '✅' : '❌'}</span>
                <span>{testResult.message}</span>
              </div>
            )}
          </div>

          <div className="flex items-center justify-between pt-3 border-t border-slate-800">
            <button
              type="submit"
              disabled={nowSaving}
              className="py-2.5 px-6 bg-gradient-to-r from-emerald-500 to-teal-400 hover:from-emerald-400 hover:to-teal-300 text-slate-950 font-black text-xs uppercase rounded-xl transition shadow-lg shadow-emerald-500/20 disabled:opacity-50"
            >
              {nowSaving ? 'Saving Configuration...' : 'Save NOWPayments Gateway'}
            </button>
            {nowSaved && <span className="text-xs text-emerald-400 font-bold">✓ Gateway Settings Saved!</span>}
          </div>
        </form>
      )}

      {/* ========================================================================= */}
      {/* TAB: BROKER & REFERRAL INTEGRATION GATEWAY (DERIV & EXPERTOPTION)         */}
      {/* ========================================================================= */}
      {activeTab === 'broker' && (
        <form onSubmit={handleSaveBrokers} className="space-y-5 font-mono text-xs">
          {/* Header intro card */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 sm:p-6 space-y-4">
            <div className="border-b border-slate-800 pb-3">
              <h3 className="text-sm font-black text-white uppercase flex items-center gap-2">
                <span>🌐</span>
                <span>Broker &amp; Referral Partner Configuration</span>
              </h3>
              <p className="text-slate-400 font-sans text-xs mt-1 max-w-2xl leading-relaxed">
                Configure affiliate broker launch links for Deriv and ExpertOption, plus the trader referral bonus. Active brokers display dynamic CTA buttons in the trader Cockpit and Top Bar. All settings persist directly to the database.
              </p>
            </div>

            {/* 1. DERIV BROKER CONFIGURATION */}
            <div className="bg-slate-950 border border-slate-800 rounded-xl p-4 space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-800/80 pb-3">
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-lg bg-rose-500/15 border border-rose-500/30 flex items-center justify-center text-rose-400 font-black text-xs">
                    D
                  </div>
                  <div>
                    <h4 className="text-xs font-bold text-white uppercase">Deriv Broker</h4>
                    <p className="text-[10px] text-slate-400 font-sans">
                      Synthetics &amp; Forex broker integration (Binary / Multipliers / MT5)
                    </p>
                  </div>
                </div>

                <label className="flex items-center gap-2 cursor-pointer bg-slate-900 border border-slate-800 py-1.5 px-3 rounded-lg hover:border-slate-700 transition shrink-0">
                  <input
                    type="checkbox"
                    checked={brokersSettings.brokers.deriv.enabled}
                    onChange={(e) =>
                      setBrokersSettings({
                        ...brokersSettings,
                        brokers: {
                          ...brokersSettings.brokers,
                          deriv: { ...brokersSettings.brokers.deriv, enabled: e.target.checked },
                        },
                      })
                    }
                    className="rounded text-emerald-500 focus:ring-emerald-500 w-4 h-4 cursor-pointer"
                  />
                  <span className={`text-xs font-bold ${brokersSettings.brokers.deriv.enabled ? 'text-emerald-400' : 'text-slate-500'}`}>
                    {brokersSettings.brokers.deriv.enabled ? '● DERIV ACTIVE' : '○ DISABLED'}
                  </span>
                </label>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                <div className="space-y-1">
                  <label className="text-[10px] text-slate-400 uppercase tracking-wider block font-bold">
                    Button Label
                  </label>
                  <input
                    type="text"
                    value={brokersSettings.brokers.deriv.label}
                    onChange={(e) =>
                      setBrokersSettings({
                        ...brokersSettings,
                        brokers: {
                          ...brokersSettings.brokers,
                          deriv: { ...brokersSettings.brokers.deriv, label: e.target.value },
                        },
                      })
                    }
                    placeholder="Open Deriv"
                    className="w-full bg-slate-900 border border-slate-800 rounded-xl py-2 px-3 text-white focus:border-emerald-500 focus:outline-none"
                  />
                </div>

                <div className="space-y-1 sm:col-span-1">
                  <label className="text-[10px] text-slate-400 uppercase tracking-wider block font-bold">
                    Deriv Referral / Affiliate URL
                  </label>
                  <input
                    type="url"
                    value={brokersSettings.brokers.deriv.referralUrl}
                    onChange={(e) =>
                      setBrokersSettings({
                        ...brokersSettings,
                        brokers: {
                          ...brokersSettings.brokers,
                          deriv: { ...brokersSettings.brokers.deriv, referralUrl: e.target.value },
                        },
                      })
                    }
                    placeholder="https://track.deriv.com/_..."
                    className="w-full bg-slate-900 border border-slate-800 rounded-xl py-2 px-3 text-white focus:border-emerald-500 focus:outline-none font-mono"
                  />
                  <p className="text-[10px] text-slate-500 font-sans">
                    Must start with https://. Traders clicking the Deriv button will be routed here.
                  </p>
                </div>

                <div className="sm:col-span-2">
                  <label className="flex items-center gap-2 cursor-pointer text-slate-300">
                    <input
                      type="checkbox"
                      checked={brokersSettings.brokers.deriv.openInNewTab}
                      onChange={(e) =>
                        setBrokersSettings({
                          ...brokersSettings,
                          brokers: {
                            ...brokersSettings.brokers,
                            deriv: { ...brokersSettings.brokers.deriv, openInNewTab: e.target.checked },
                          },
                        })
                      }
                      className="rounded text-emerald-500 focus:ring-emerald-500"
                    />
                    <span>Open Deriv link in a new browser tab</span>
                  </label>
                </div>
              </div>
            </div>

            {/* 2. EXPERTOPTION BROKER CONFIGURATION */}
            <div className="bg-slate-950 border border-slate-800 rounded-xl p-4 space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-800/80 pb-3">
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-lg bg-blue-500/15 border border-blue-500/30 flex items-center justify-center text-blue-400 font-black text-xs">
                    EO
                  </div>
                  <div>
                    <h4 className="text-xs font-bold text-white uppercase">ExpertOption Broker</h4>
                    <p className="text-[10px] text-slate-400 font-sans">
                      Quick expiry digital options broker integration
                    </p>
                  </div>
                </div>

                <label className="flex items-center gap-2 cursor-pointer bg-slate-900 border border-slate-800 py-1.5 px-3 rounded-lg hover:border-slate-700 transition shrink-0">
                  <input
                    type="checkbox"
                    checked={brokersSettings.brokers.expertOption.enabled}
                    onChange={(e) =>
                      setBrokersSettings({
                        ...brokersSettings,
                        brokers: {
                          ...brokersSettings.brokers,
                          expertOption: { ...brokersSettings.brokers.expertOption, enabled: e.target.checked },
                        },
                      })
                    }
                    className="rounded text-emerald-500 focus:ring-emerald-500 w-4 h-4 cursor-pointer"
                  />
                  <span className={`text-xs font-bold ${brokersSettings.brokers.expertOption.enabled ? 'text-emerald-400' : 'text-slate-500'}`}>
                    {brokersSettings.brokers.expertOption.enabled ? '● EXPERTOPTION ACTIVE' : '○ DISABLED'}
                  </span>
                </label>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                <div className="space-y-1">
                  <label className="text-[10px] text-slate-400 uppercase tracking-wider block font-bold">
                    Button Label
                  </label>
                  <input
                    type="text"
                    value={brokersSettings.brokers.expertOption.label}
                    onChange={(e) =>
                      setBrokersSettings({
                        ...brokersSettings,
                        brokers: {
                          ...brokersSettings.brokers,
                          expertOption: { ...brokersSettings.brokers.expertOption, label: e.target.value },
                        },
                      })
                    }
                    placeholder="Open ExpertOption"
                    className="w-full bg-slate-900 border border-slate-800 rounded-xl py-2 px-3 text-white focus:border-emerald-500 focus:outline-none"
                  />
                </div>

                <div className="space-y-1 sm:col-span-1">
                  <label className="text-[10px] text-slate-400 uppercase tracking-wider block font-bold">
                    ExpertOption Referral / Affiliate URL
                  </label>
                  <input
                    type="url"
                    value={brokersSettings.brokers.expertOption.referralUrl}
                    onChange={(e) =>
                      setBrokersSettings({
                        ...brokersSettings,
                        brokers: {
                          ...brokersSettings.brokers,
                          expertOption: { ...brokersSettings.brokers.expertOption, referralUrl: e.target.value },
                        },
                      })
                    }
                    placeholder="https://expertoption.com/?ref=..."
                    className="w-full bg-slate-900 border border-slate-800 rounded-xl py-2 px-3 text-white focus:border-emerald-500 focus:outline-none font-mono"
                  />
                  <p className="text-[10px] text-slate-500 font-sans">
                    Must start with https://. Traders clicking ExpertOption will be routed here.
                  </p>
                </div>

                <div className="sm:col-span-2">
                  <label className="flex items-center gap-2 cursor-pointer text-slate-300">
                    <input
                      type="checkbox"
                      checked={brokersSettings.brokers.expertOption.openInNewTab}
                      onChange={(e) =>
                        setBrokersSettings({
                          ...brokersSettings,
                          brokers: {
                            ...brokersSettings.brokers,
                            expertOption: { ...brokersSettings.brokers.expertOption, openInNewTab: e.target.checked },
                          },
                        })
                      }
                      className="rounded text-emerald-500 focus:ring-emerald-500"
                    />
                    <span>Open ExpertOption link in a new browser tab</span>
                  </label>
                </div>
              </div>
            </div>

            {/* 3. REFERRAL BONUS CONFIGURATION */}
            <div className="bg-slate-950 border border-slate-800 rounded-xl p-4 space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-800/80 pb-3">
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-lg bg-amber-500/15 border border-amber-500/30 flex items-center justify-center text-amber-400 font-black text-xs">
                    🎁
                  </div>
                  <div>
                    <h4 className="text-xs font-bold text-white uppercase">Registration Referral Bonus</h4>
                    <p className="text-[10px] text-slate-400 font-sans">
                      Reward traders with free extra credits when they register via your referral code or ?ref= link
                    </p>
                  </div>
                </div>

                <label className="flex items-center gap-2 cursor-pointer bg-slate-900 border border-slate-800 py-1.5 px-3 rounded-lg hover:border-slate-700 transition shrink-0">
                  <input
                    type="checkbox"
                    checked={brokersSettings.referralBonus.enabled}
                    onChange={(e) =>
                      setBrokersSettings({
                        ...brokersSettings,
                        referralBonus: { ...brokersSettings.referralBonus, enabled: e.target.checked },
                      })
                    }
                    className="rounded text-amber-500 focus:ring-amber-500 w-4 h-4 cursor-pointer"
                  />
                  <span className={`text-xs font-bold ${brokersSettings.referralBonus.enabled ? 'text-amber-400' : 'text-slate-500'}`}>
                    {brokersSettings.referralBonus.enabled ? '● BONUS ACTIVE' : '○ DISABLED'}
                  </span>
                </label>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                <div className="space-y-1">
                  <label className="text-[10px] text-slate-400 uppercase tracking-wider block font-bold">
                    Extra Free Credits Granted
                  </label>
                  <input
                    type="number"
                    min="1"
                    max="50"
                    value={brokersSettings.referralBonus.extraCredits}
                    onChange={(e) =>
                      setBrokersSettings({
                        ...brokersSettings,
                        referralBonus: { ...brokersSettings.referralBonus, extraCredits: Math.max(1, parseInt(e.target.value) || 5) },
                      })
                    }
                    className="w-full bg-slate-900 border border-slate-800 rounded-xl py-2 px-3 text-amber-400 font-bold focus:border-amber-500 focus:outline-none"
                  />
                  <p className="text-[10px] text-slate-500 font-sans">
                    Added on top of standard welcome credits (e.g. 10 + {brokersSettings.referralBonus.extraCredits} = {10 + brokersSettings.referralBonus.extraCredits} Credits).
                  </p>
                </div>

                <div className="space-y-1">
                  <label className="text-[10px] text-slate-400 uppercase tracking-wider block font-bold">
                    Default Referral Code
                  </label>
                  <input
                    type="text"
                    value={brokersSettings.referralBonus.referralCode || 'TOLVEXA'}
                    onChange={(e) =>
                      setBrokersSettings({
                        ...brokersSettings,
                        referralBonus: { ...brokersSettings.referralBonus, referralCode: e.target.value.toUpperCase() },
                      })
                    }
                    placeholder="TOLVEXA"
                    className="w-full bg-slate-900 border border-slate-800 rounded-xl py-2 px-3 text-white font-mono focus:border-amber-500 focus:outline-none"
                  />
                  <p className="text-[10px] text-slate-500 font-sans">
                    Traders who register with this code or visit with <code className="text-amber-300">?ref={brokersSettings.referralBonus.referralCode || 'TOLVEXA'}</code> receive the bonus.
                  </p>
                </div>

                <div className="space-y-1 sm:col-span-2">
                  <label className="text-[10px] text-slate-400 uppercase tracking-wider block font-bold">
                    Promo Explanation Banner Message
                  </label>
                  <textarea
                    rows={2}
                    value={brokersSettings.referralBonus.message}
                    onChange={(e) =>
                      setBrokersSettings({
                        ...brokersSettings,
                        referralBonus: { ...brokersSettings.referralBonus, message: e.target.value },
                      })
                    }
                    placeholder="Sign up using partner referral link or enter code to receive +5 bonus credits!"
                    className="w-full bg-slate-900 border border-slate-800 rounded-xl py-2 px-3 text-white focus:border-amber-500 focus:outline-none font-sans"
                  />
                </div>
              </div>
            </div>

            {/* LIVE COCKPIT PREVIEW CARD */}
            <div className="bg-slate-950 border border-slate-800/80 rounded-xl p-4 space-y-3">
              <span className="text-[10px] text-slate-400 uppercase tracking-wider block font-bold">
                Traders UI Live Preview
              </span>
              <div className="p-3 bg-slate-900 border border-slate-800 rounded-xl flex flex-col md:flex-row md:items-center justify-between gap-3">
                <div className="text-xs text-slate-300 space-y-1">
                  {brokersSettings.referralBonus.enabled && (
                    <div className="flex items-center gap-1.5 text-amber-400 font-bold text-[11px]">
                      <span>🎁 Referral Bonus Active:</span>
                      <span className="text-white">+{brokersSettings.referralBonus.extraCredits} Free Credits on signup with code</span>
                      <span className="px-1.5 py-0.2 bg-amber-500/20 rounded border border-amber-500/30 text-amber-300 font-mono">
                        {brokersSettings.referralBonus.referralCode || 'TOLVEXA'}
                      </span>
                    </div>
                  )}
                  <div className="text-slate-400 text-[11px]">
                    Visible CTAs: {(!brokersSettings.brokers.deriv.enabled && !brokersSettings.brokers.expertOption.enabled) ? (
                      <span className="text-slate-500 italic">None (All broker buttons hidden)</span>
                    ) : (
                      <span>
                        {brokersSettings.brokers.deriv.enabled && <strong className="text-rose-400 mr-2">Deriv</strong>}
                        {brokersSettings.brokers.expertOption.enabled && <strong className="text-blue-400">ExpertOption</strong>}
                      </span>
                    )}
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {brokersSettings.brokers.deriv.enabled && (
                    <a
                      href={brokersSettings.brokers.deriv.referralUrl || '#'}
                      target={brokersSettings.brokers.deriv.openInNewTab ? '_blank' : '_self'}
                      rel="noopener noreferrer"
                      className="py-1.5 px-3.5 bg-gradient-to-r from-rose-500 to-red-600 hover:from-rose-400 hover:to-red-500 text-white font-black rounded-xl transition text-xs shadow-md shadow-rose-500/20 flex items-center gap-1.5"
                    >
                      <span>⚡</span>
                      <span>{brokersSettings.brokers.deriv.label || 'Open Deriv'}</span>
                      <span className="text-[10px]">↗</span>
                    </a>
                  )}

                  {brokersSettings.brokers.expertOption.enabled && (
                    <a
                      href={brokersSettings.brokers.expertOption.referralUrl || '#'}
                      target={brokersSettings.brokers.expertOption.openInNewTab ? '_blank' : '_self'}
                      rel="noopener noreferrer"
                      className="py-1.5 px-3.5 bg-gradient-to-r from-blue-500 to-indigo-600 hover:from-blue-400 hover:to-indigo-500 text-white font-black rounded-xl transition text-xs shadow-md shadow-blue-500/20 flex items-center gap-1.5"
                    >
                      <span>⚡</span>
                      <span>{brokersSettings.brokers.expertOption.label || 'Open ExpertOption'}</span>
                      <span className="text-[10px]">↗</span>
                    </a>
                  )}
                </div>
              </div>
            </div>

            {/* 4. SUPPORTED TRADING PLATFORMS (COCKPIT SELECTOR & LANDING) */}
            <div className="bg-slate-950 border border-slate-800 rounded-xl p-4 space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-800/80 pb-3">
                <div>
                  <h4 className="text-xs font-bold text-white uppercase flex items-center gap-2">
                    <span>📊 Supported Broker Platforms &amp; Strategy Profiles</span>
                  </h4>
                  <p className="text-[10px] text-slate-400 font-sans">
                    Configure which broker platforms appear in the unified Cockpit selector. Selecting a binary broker sets the BINARY_QUICK profile (expiry minutes + CALL/PUT), while MetaTrader 5 activates the MT5 profile (Entry, SL, TP1, TP2).
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleSaveBrokerPlatforms}
                  disabled={platformsSaving}
                  className="py-1.5 px-4 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs rounded-xl transition shadow"
                >
                  {platformsSaving ? 'Saving...' : '💾 Save Platforms'}
                </button>
              </div>

              <div className="space-y-3">
                {brokerPlatforms.map((bp, idx) => (
                  <div
                    key={bp.id}
                    className="p-3 bg-slate-900 border border-slate-800 rounded-xl flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                  >
                    <div className="flex items-center gap-3">
                      <span className="text-lg">{bp.icon}</span>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-white text-xs">{bp.name}</span>
                          <span className={`text-[10px] px-1.5 py-0.2 rounded font-bold uppercase ${
                            bp.profile === 'MT5'
                              ? 'bg-blue-500/20 text-blue-300 border border-blue-500/40'
                              : 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                          }`}>
                            {bp.profile}
                          </span>
                        </div>
                        <p className="text-[10px] text-slate-400">{bp.description}</p>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-3">
                      <input
                        type="url"
                        placeholder="https://... referral URL"
                        value={bp.referralUrl || ''}
                        onChange={(e) => {
                          const updated = [...brokerPlatforms];
                          updated[idx] = { ...updated[idx], referralUrl: e.target.value };
                          setBrokerPlatforms(updated);
                        }}
                        className="bg-slate-950 border border-slate-800 rounded-lg py-1 px-2 text-[11px] text-slate-300 font-mono w-48 sm:w-56 focus:border-emerald-500 focus:outline-none"
                      />

                      <label className="flex items-center gap-1.5 cursor-pointer text-xs">
                        <input
                          type="checkbox"
                          checked={bp.enabled}
                          onChange={(e) => {
                            const updated = [...brokerPlatforms];
                            updated[idx] = { ...updated[idx], enabled: e.target.checked };
                            setBrokerPlatforms(updated);
                          }}
                          className="rounded text-emerald-500 focus:ring-emerald-500"
                        />
                        <span className={bp.enabled ? 'text-emerald-400 font-bold' : 'text-slate-500'}>
                          {bp.enabled ? 'Active' : 'Off'}
                        </span>
                      </label>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* SAVE BUTTON */}
            <div className="pt-2 flex items-center gap-3">
              <button
                type="submit"
                disabled={brokerSaving}
                className="py-2.5 px-6 bg-gradient-to-r from-emerald-500 to-teal-400 hover:from-emerald-400 hover:to-teal-300 disabled:opacity-50 text-slate-950 font-black rounded-xl transition shadow-lg shadow-emerald-500/20 flex items-center gap-2 cursor-pointer"
              >
                <span>{brokerSaving ? 'Saving to Database...' : 'Save Broker & Referral Settings'}</span>
              </button>
              {brokerSaved && (
                <span className="text-xs text-emerald-400 font-bold font-mono">
                  ✓ Broker &amp; Referral settings saved to database successfully!
                </span>
              )}
            </div>
          </div>
        </form>
      )}

      {/* ========================================================================= */}
      {/* TAB 5: BRANDING & PLATFORM CONFIG                                         */}
      {/* ========================================================================= */}
      {activeTab === 'branding' && (
        <form onSubmit={handleSaveBranding} className="space-y-4 font-mono text-xs">
          <div className="bg-slate-950/40 border border-slate-800 rounded-xl p-4 space-y-1">
            <h4 className="text-sm font-black text-white uppercase tracking-wider flex items-center gap-2">
              <span>🎨</span>
              <span>Platform Branding &amp; Identity Controls</span>
            </h4>
            <p className="text-slate-400 font-sans text-xs">
              Configure your platform logo, custom browser favicon, platform name, announcement banner, and support channels.
              Saved settings are broadcasted in real time to all active traders and applied to the browser document head without redeployment.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Logo Upload & URL */}
            <div className="space-y-2 sm:col-span-2 bg-slate-950 border border-slate-800 p-4 rounded-xl">
              <div className="flex items-center justify-between">
                <label className="text-[10px] text-slate-400 uppercase tracking-wider block font-bold">
                  Platform Logo (Upload Designed Logo or Paste URL)
                </label>
                {siteSettings.logoUrl && (
                  <button
                    type="button"
                    onClick={() => setSiteSettings({ ...siteSettings, logoUrl: '' })}
                    className="text-[10px] text-rose-400 hover:text-rose-300 font-bold flex items-center gap-1"
                  >
                    ✕ Remove Custom Logo
                  </button>
                )}
              </div>

              <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
                {/* Upload Designed Logo Button */}
                <label
                  htmlFor="admin-logo-upload"
                  className="px-4 py-2.5 bg-gradient-to-r from-emerald-500 to-teal-400 hover:from-emerald-400 hover:to-teal-300 text-slate-950 font-black rounded-xl cursor-pointer transition shadow-md shadow-emerald-500/20 flex items-center justify-center gap-2 shrink-0 select-none text-xs"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                  </svg>
                  <span>Upload Designed Logo</span>
                </label>
                <input
                  id="admin-logo-upload"
                  type="file"
                  accept="image/png,image/jpeg,image/svg+xml,image/webp,image/gif"
                  onChange={handleLogoUpload}
                  className="hidden"
                />

                {/* Or Paste URL */}
                <div className="flex-1 flex items-center gap-2">
                  <span className="text-[11px] text-slate-500 font-mono hidden sm:inline">or</span>
                  <input
                    type="text"
                    value={siteSettings.logoUrl || ''}
                    onChange={(e) => setSiteSettings({ ...siteSettings, logoUrl: e.target.value })}
                    placeholder="https://... or uploaded base64 data image"
                    className="flex-1 w-full bg-slate-900 border border-slate-800 rounded-xl py-2 px-3 text-white focus:border-emerald-500 focus:outline-none font-mono text-xs"
                  />
                </div>

                {/* Live Logo Preview */}
                <div className="flex items-center gap-2 shrink-0 self-center sm:self-auto">
                  <span className="text-[10px] text-slate-500">Preview:</span>
                  <div className="w-11 h-11 rounded-xl bg-slate-900 border border-slate-700 flex items-center justify-center p-1.5 overflow-hidden shadow-sm">
                    {siteSettings.logoUrl ? (
                      <img
                        src={siteSettings.logoUrl}
                        alt="Logo preview"
                        className="max-h-full max-w-full object-contain"
                        onError={(e) => {
                          (e.currentTarget as HTMLImageElement).style.display = 'none';
                        }}
                      />
                    ) : (
                      <span className="text-emerald-400 font-bold text-sm">⚡</span>
                    )}
                  </div>
                </div>
              </div>
              <p className="text-[10px] text-slate-500 font-sans">
                Supports PNG, SVG, JPG, WebP (up to 2MB). Recommended square or 120x120px with transparent background. Appears in navigation headers across desktop and mobile.
              </p>
            </div>

            {/* Favicon Upload & URL */}
            <div className="space-y-2 sm:col-span-2 bg-slate-950 border border-slate-800 p-4 rounded-xl">
              <div className="flex items-center justify-between">
                <label className="text-[10px] text-slate-400 uppercase tracking-wider block font-bold">
                  Browser Favicon (.ico / .svg / .png)
                </label>
                {siteSettings.faviconUrl && (
                  <button
                    type="button"
                    onClick={() => setSiteSettings({ ...siteSettings, faviconUrl: '' })}
                    className="text-[10px] text-rose-400 hover:text-rose-300 font-bold flex items-center gap-1"
                  >
                    ✕ Reset to Default
                  </button>
                )}
              </div>

              <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
                {/* Upload Designed Favicon Button */}
                <label
                  htmlFor="admin-favicon-upload"
                  className="px-4 py-2.5 bg-gradient-to-r from-amber-500 to-amber-400 hover:from-amber-400 hover:to-amber-300 text-slate-950 font-black rounded-xl cursor-pointer transition shadow-md shadow-amber-500/20 flex items-center justify-center gap-2 shrink-0 select-none text-xs"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                  </svg>
                  <span>Upload Designed Favicon</span>
                </label>
                <input
                  id="admin-favicon-upload"
                  type="file"
                  accept="image/x-icon,image/vnd.microsoft.icon,image/png,image/svg+xml,image/webp,image/jpeg"
                  onChange={handleFaviconUpload}
                  className="hidden"
                />

                {/* Or Paste URL */}
                <div className="flex-1 flex items-center gap-2">
                  <span className="text-[11px] text-slate-500 font-mono hidden sm:inline">or</span>
                  <input
                    type="text"
                    value={siteSettings.faviconUrl || ''}
                    onChange={(e) => setSiteSettings({ ...siteSettings, faviconUrl: e.target.value })}
                    placeholder="https://... or uploaded base64 data favicon"
                    className="flex-1 w-full bg-slate-900 border border-slate-800 rounded-xl py-2 px-3 text-white focus:border-amber-500 focus:outline-none font-mono text-xs"
                  />
                </div>

                {/* Live Favicon Preview in Browser Tab Mockup */}
                <div className="flex items-center gap-2 shrink-0 self-center sm:self-auto">
                  <span className="text-[10px] text-slate-500">Tab Icon:</span>
                  <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-slate-900 border border-slate-700 shadow-sm">
                    <div className="w-4 h-4 rounded flex items-center justify-center overflow-hidden">
                      {siteSettings.faviconUrl ? (
                        <img
                          src={siteSettings.faviconUrl}
                          alt="Favicon preview"
                          className="w-full h-full object-contain"
                          onError={(e) => {
                            (e.currentTarget as HTMLImageElement).style.display = 'none';
                          }}
                        />
                      ) : (
                        <span className="text-emerald-400 text-xs">◈</span>
                      )}
                    </div>
                    <span className="text-[10px] text-slate-300 font-sans max-w-[90px] truncate">
                      {siteSettings.siteName || 'PulseTrade'}
                    </span>
                  </div>
                </div>
              </div>
              <p className="text-[10px] text-slate-500 font-sans">
                Immediately updates browser tab icons and bookmarks across the site at runtime. Supports .ico, .png, and .svg.
              </p>
            </div>

            <div className="space-y-1">
              <label className="text-[10px] text-slate-400 uppercase tracking-wider block font-bold">
                Platform Name
              </label>
              <input
                type="text"
                value={siteSettings.siteName}
                onChange={(e) => setSiteSettings({ ...siteSettings, siteName: e.target.value })}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl py-2 px-3 text-white focus:border-amber-500 focus:outline-none"
              />
            </div>

            <div className="space-y-1">
              <label className="text-[10px] text-slate-400 uppercase tracking-wider block font-bold">
                Tagline / Subtitle
              </label>
              <input
                type="text"
                value={siteSettings.siteTagline}
                onChange={(e) => setSiteSettings({ ...siteSettings, siteTagline: e.target.value })}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl py-2 px-3 text-white focus:border-amber-500 focus:outline-none"
              />
            </div>

            <div className="space-y-1">
              <label className="text-[10px] text-slate-400 uppercase tracking-wider block font-bold">
                Version / Header Badge
              </label>
              <input
                type="text"
                value={siteSettings.badgeText || ''}
                onChange={(e) => setSiteSettings({ ...siteSettings, badgeText: e.target.value })}
                placeholder="v8.2 QUANT"
                className="w-full bg-slate-950 border border-slate-800 rounded-xl py-2 px-3 text-white focus:border-amber-500 focus:outline-none"
              />
            </div>

            <div className="space-y-1">
              <label className="text-[10px] text-slate-400 uppercase tracking-wider block font-bold">
                Official Support Email
              </label>
              <input
                type="email"
                value={siteSettings.supportEmail || ''}
                onChange={(e) => setSiteSettings({ ...siteSettings, supportEmail: e.target.value })}
                placeholder="support@pulsetrade.pro"
                className="w-full bg-slate-950 border border-slate-800 rounded-xl py-2 px-3 text-white focus:border-amber-500 focus:outline-none"
              />
            </div>

            <div className="space-y-1 sm:col-span-2 bg-slate-950 border border-slate-800 p-3.5 rounded-xl">
              <div className="flex items-center justify-between mb-2">
                <div>
                  <div className="text-xs font-bold text-white">Announcement Banner</div>
                  <div className="text-[10px] text-slate-400">
                    Displays a high-visibility global ticker banner at the top of all pages.
                  </div>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    checked={siteSettings.bannerEnabled}
                    onChange={(e) => setSiteSettings({ ...siteSettings, bannerEnabled: e.target.checked })}
                    className="sr-only peer"
                  />
                  <div className="w-11 h-6 bg-slate-800 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-amber-500"></div>
                </label>
              </div>
              <input
                type="text"
                value={siteSettings.bannerText}
                onChange={(e) => setSiteSettings({ ...siteSettings, bannerText: e.target.value })}
                placeholder="Announcement message for all visitors..."
                className="w-full bg-slate-900 border border-slate-800 rounded-xl py-2 px-3 text-white focus:border-amber-500 focus:outline-none text-xs"
              />
            </div>

            <div className="space-y-1">
              <label className="text-[10px] text-slate-400 uppercase tracking-wider block font-bold">
                Telegram Support Link
              </label>
              <input
                type="text"
                value={siteSettings.supportTelegram}
                onChange={(e) => setSiteSettings({ ...siteSettings, supportTelegram: e.target.value })}
                placeholder="https://t.me/yourchannel"
                className="w-full bg-slate-950 border border-slate-800 rounded-xl py-2 px-3 text-white focus:border-amber-500 focus:outline-none"
              />
            </div>

            <div className="space-y-1">
              <label className="text-[10px] text-slate-400 uppercase tracking-wider block font-bold">
                WhatsApp Support Link
              </label>
              <input
                type="text"
                value={siteSettings.supportWhatsapp}
                onChange={(e) => setSiteSettings({ ...siteSettings, supportWhatsapp: e.target.value })}
                placeholder="https://wa.me/..."
                className="w-full bg-slate-950 border border-slate-800 rounded-xl py-2 px-3 text-white focus:border-amber-500 focus:outline-none"
              />
            </div>
          </div>

          <div className="flex items-center justify-between pt-3 border-t border-slate-800">
            <button
              type="submit"
              disabled={settingsSaving}
              className="py-2.5 px-6 bg-gradient-to-r from-amber-500 to-amber-400 hover:from-amber-400 hover:to-amber-300 text-slate-950 font-black text-xs uppercase rounded-xl transition shadow-lg shadow-amber-500/20 disabled:opacity-50"
            >
              {settingsSaving ? 'Saving...' : 'Save & Broadcast Branding'}
            </button>
            {settingsSaved && <span className="text-xs text-emerald-400 font-bold">✓ Settings Saved &amp; Applied!</span>}
          </div>
        </form>
      )}

      {/* ========================================================================= */}
      {/* TAB 6: BLOG CMS (ADMIN-EDITABLE)                                          */}
      {/* ========================================================================= */}
      {activeTab === 'blog' && (
        <div className="space-y-4 font-mono text-xs">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 flex items-center justify-between">
            <div>
              <h3 className="text-sm font-black text-white uppercase">📰 Algorithmic Academy Blog CMS</h3>
              <p className="text-slate-400 font-sans text-xs">Publish research articles and SEO guides directly to the public Academy.</p>
            </div>
            <button
              type="button"
              onClick={() => {
                setEditingPost({
                  id: `post_${Date.now()}`,
                  title: '',
                  category: 'Quantitative Strategy',
                  excerpt: '',
                  body: '',
                  cover_url: '',
                  is_published: true,
                });
                setIsBlogModalOpen(true);
              }}
              className="py-2 px-4 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold rounded-xl transition"
            >
              + Create Article
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {blogPosts.length === 0 ? (
              <div className="col-span-2 text-center text-slate-500 py-8">
                No custom articles created yet. Default SEO research articles are loaded on the public Blog.
              </div>
            ) : (
              blogPosts.map((post) => (
                <div key={post.id} className="bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] bg-emerald-500/20 text-emerald-300 px-2 py-0.5 rounded">
                      {post.category || 'Trading Strategy'}
                    </span>
                    <span className={`text-[10px] ${post.is_published ? 'text-emerald-400' : 'text-slate-500'}`}>
                      {post.is_published ? '● PUBLISHED' : '○ DRAFT'}
                    </span>
                  </div>
                  <div className="font-bold text-white text-sm">{post.title}</div>
                  <p className="text-slate-400 font-sans text-xs line-clamp-2">{post.excerpt}</p>
                  <div className="flex justify-end gap-2 pt-2 border-t border-slate-800/80">
                    <button
                      type="button"
                      onClick={() => {
                        setEditingPost(post);
                        setIsBlogModalOpen(true);
                      }}
                      className="text-amber-400 hover:underline"
                    >
                      Edit
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Blog Edit Modal */}
          {isBlogModalOpen && editingPost && (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-in fade-in">
              <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-lg w-full p-5 space-y-4 shadow-2xl">
                <div className="flex items-center justify-between border-b border-slate-800 pb-2">
                  <div className="font-bold text-sm text-white">Publish / Edit Blog Article</div>
                  <button type="button" onClick={() => setIsBlogModalOpen(false)} className="text-slate-400 hover:text-white">
                    ✕
                  </button>
                </div>

                <form onSubmit={handleSaveBlogPost} className="space-y-3 text-xs font-mono">
                  <div>
                    <label className="text-[10px] text-slate-400 uppercase tracking-wider block font-bold mb-1">Article Title</label>
                    <input
                      type="text"
                      required
                      value={editingPost.title || ''}
                      onChange={(e) => setEditingPost({ ...editingPost, title: e.target.value })}
                      placeholder="e.g. Sub-Second Arbitrage and Slippage Mitigation"
                      className="w-full bg-slate-950 border border-slate-800 rounded-xl py-2 px-3 text-white focus:border-emerald-500 focus:outline-none"
                    />
                  </div>

                  <div>
                    <label className="text-[10px] text-slate-400 uppercase tracking-wider block font-bold mb-1">Category</label>
                    <input
                      type="text"
                      value={editingPost.category || ''}
                      onChange={(e) => setEditingPost({ ...editingPost, category: e.target.value })}
                      className="w-full bg-slate-950 border border-slate-800 rounded-xl py-2 px-3 text-white focus:border-emerald-500 focus:outline-none"
                    />
                  </div>

                  <div>
                    <label className="text-[10px] text-slate-400 uppercase tracking-wider block font-bold mb-1">Excerpt / Summary</label>
                    <textarea
                      rows={2}
                      value={editingPost.excerpt || ''}
                      onChange={(e) => setEditingPost({ ...editingPost, excerpt: e.target.value })}
                      className="w-full bg-slate-950 border border-slate-800 rounded-xl py-2 px-3 text-white font-sans focus:border-emerald-500 focus:outline-none"
                    />
                  </div>

                  <div>
                    <label className="text-[10px] text-slate-400 uppercase tracking-wider block font-bold mb-1">Body Text</label>
                    <textarea
                      rows={5}
                      value={editingPost.body || ''}
                      onChange={(e) => setEditingPost({ ...editingPost, body: e.target.value })}
                      className="w-full bg-slate-950 border border-slate-800 rounded-xl py-2 px-3 text-white font-sans focus:border-emerald-500 focus:outline-none"
                    />
                  </div>

                  <div className="flex items-center justify-between pt-2">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={editingPost.is_published}
                        onChange={(e) => setEditingPost({ ...editingPost, is_published: e.target.checked })}
                      />
                      <span className="text-white">Publish Article Instantly</span>
                    </label>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => setIsBlogModalOpen(false)}
                        className="py-1.5 px-3 text-slate-400 hover:text-white"
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        className="py-2 px-5 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold rounded-xl transition"
                      >
                        Save &amp; Publish
                      </button>
                    </div>
                  </div>
                </form>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ========================================================================= */}
      {/* TAB 7: ANTI-ABUSE IP GUARD                                                */}
      {/* ========================================================================= */}
      {activeTab === 'abuse' && (
        <div className="space-y-3 font-mono text-xs">
          <div className="text-slate-400">
            Real-time IP registration audit ledger preventing sybil attacks and free bonus depletion:
          </div>

          <div className="overflow-x-auto border border-slate-800 rounded-xl">
            <table className="w-full text-left">
              <thead className="bg-slate-950 text-slate-400 text-[10px] uppercase">
                <tr>
                  <th className="p-3">IP Address</th>
                  <th className="p-3">Accounts Registered</th>
                  <th className="p-3">Recent User</th>
                  <th className="p-3">Security Status</th>
                  <th className="p-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/80 text-[11px]">
                {ipLogs.map((log) => (
                  <tr key={log.ip} className="hover:bg-slate-950/40">
                    <td className="p-3 text-white font-bold">{log.ip}</td>
                    <td className="p-3 text-slate-300">{log.count} / {ipLimit} limit</td>
                    <td className="p-3 text-slate-400">{log.lastUser}</td>
                    <td className="p-3">
                      <span
                        className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                          log.status === 'SAFE'
                            ? 'bg-emerald-500/20 text-emerald-400'
                            : log.status === 'MAX_REACHED'
                            ? 'bg-amber-500/20 text-amber-400'
                            : 'bg-rose-500/20 text-rose-400'
                        }`}
                      >
                        {log.status}
                      </span>
                    </td>
                    <td className="p-3 text-right">
                      <button
                        type="button"
                        onClick={() => handleResetIp(log.ip)}
                        className="text-slate-400 hover:text-amber-300 underline"
                      >
                        Reset Limit
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* TAB 8: SUPABASE & SQL CLOUD DATABASE                                      */}
      {/* ========================================================================= */}
      {activeTab === 'database' && (
        <div className="space-y-4">
          <SupabaseManager onlineUsers={onlineUsers} onLaunchCockpit={onExitAdmin} />
        </div>
      )}

      {/* ========================================================================= */}
      {/* TAB 9: SYSTEM DIAGNOSTICS & BACKEND SERVER FILES                          */}
      {/* ========================================================================= */}
      {activeTab === 'system' && (
        <div className="space-y-4">
          <SystemFilesViewer />
        </div>
      )}
    </div>
  );
}
