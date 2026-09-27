"use client";

import {
  useCallback,
  useEffect,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { Transaction } from "@solana/web3.js";
import { DashboardViews } from "./DashboardViews";
import { getSolanaProvider, } from "@/lib/phantom";

type Product = {
  id: string;
  name: string;
  description: string;
  price: number;
  inventory: number;
  status: "Live" | "Draft" | "Sold out";
  image: string;
  color: string;
  variants: {
    id: string;
    name: string;
    value: string;
    inventory: number;
  }[];
};

type ApiProduct = {
  id: string;
  name: string;
  description: string;
  priceUsdc: number;
  inventory: number;
  status: "active" | "inactive" | "sold_out";
  imageUrl: string;
  variants: Product["variants"];
};

type ApiOrder = {
  id: string;
  productId: string;
  buyerWallet: string;
  amountUsdc: number;
  status: "pending" | "paid" | "failed" | "cancelled";
  createdAt: string;
  variant?: string;
  quantity: number;
  txSignature?: string;
};

type DashboardOrder = {
  id: string;
  product: string;
  buyer: string;
  amount: number;
  status: string;
  time: string;
  variant?: string;
  quantity: number;
  txSignature?: string;
};

type ProductFormVariant = {
  name: string;
  value: string;
  inventory: string;
};

function toProduct(product: ApiProduct): Product {
  return {
    id: product.id,
    name: product.name,
    description: product.description,
    price: product.priceUsdc,
    inventory: product.inventory,
    status:
      product.status === "active"
        ? "Live"
        : product.status === "sold_out"
          ? "Sold out"
          : "Draft",
    image: product.imageUrl,
    color: "#e9c2a9",
    variants: product.variants,
  };
}

function Icon({ children }: { children: ReactNode }) {
  return (
    <span className="nav-icon" aria-hidden="true">
      {children}
    </span>
  );
}

function formatUsdc(value: number) {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(value);
}

function shortValue(value: string) {
  return value.length > 12
    ? `${value.slice(0, 5)}…${value.slice(-5)}`
    : value;
}

function paymentErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message.toLowerCase() : "";

  if (message.includes("reject") || message.includes("cancel")) {
    return "The wallet request was cancelled. No payment was made.";
  }
  if (message.includes("insufficient") || message.includes("stock")) {
    return "That quantity is no longer available. Choose a lower quantity and try again.";
  }
  if (message.includes("network") || message.includes("cluster")) {
    return "Please switch Phantom to Solana Devnet and try again.";
  }
  if (message.includes("wallet") || message.includes("phantom")) {
    return "Phantom is unavailable. Unlock or install Phantom, then try again.";
  }
  if (message.includes("confirm") || message.includes("verif")) {
    return "We could not verify the payment yet. Check Phantom before trying again.";
  }

  return "Payment could not be completed. Please try again.";
}

function SettingsView() {
  return (
    <div className="content-inner">
      <div className="page-heading">
        <div>
          <p className="eyebrow">WORKSPACE SETTINGS</p>

          <h1>
            Settings
            <span className="heading-period">.</span>
          </h1>

          <p className="subheading">
            Manage your BlinkShop workspace and checkout configuration.
          </p>
        </div>
      </div>

      <section className="settings-grid">
        <article className="stat-card">
          <div className="stat-top">
            <span>Workspace</span>
            <span className="stat-icon mint">A</span>
          </div>

          <strong>Aria Studio</strong>

          <div className="stat-foot">
            <span>Merchant workspace</span>
          </div>
        </article>

        <article className="stat-card">
          <div className="stat-top">
            <span>Network</span>
            <span className="stat-icon lemon">●</span>
          </div>

          <strong>Solana Devnet</strong>

          <div className="stat-foot">
            <span>Development environment</span>
          </div>
        </article>

        <article className="stat-card">
          <div className="stat-top">
            <span>Checkout</span>
            <span className="stat-icon lilac">↗</span>
          </div>

          <strong>USDC</strong>

          <div className="stat-foot">
            <span>Onchain payment currency</span>
          </div>
        </article>
      </section>

      <section className="section-header">
        <div>
          <h2 className="section-title">
            Merchant settings
          </h2>

          <p className="section-description">
            Configure the information used by your Blink checkout.
          </p>
        </div>
      </section>

      <section className="settings-panel">
        <div className="settings-row">
          <div>
            <strong>Merchant workspace</strong>
            <p>Aria Studio</p>
          </div>

          <span className="settings-badge">
            Active
          </span>
        </div>

        <div className="settings-row">
          <div>
            <strong>Blockchain network</strong>
            <p>Solana Devnet</p>
          </div>

          <span className="settings-badge">
            Devnet
          </span>
        </div>

        <div className="settings-row">
          <div>
            <strong>Payment asset</strong>
            <p>USDC</p>
          </div>

          <span className="settings-badge">
            Enabled
          </span>
        </div>

        <div className="settings-row">
          <div>
            <strong>Blink checkout</strong>
            <p>
              Social-native checkout is enabled for your products.
            </p>
          </div>

          <span className="settings-badge">
            Enabled
          </span>
        </div>
      </section>

      <section className="section-header orders-heading">
        <div>
          <h2 className="section-title">
            Development mode
          </h2>

          <p className="section-description">
            BlinkShop is currently running on Solana Devnet for testing.
          </p>
        </div>
      </section>

      <section className="settings-panel">
        <div className="settings-row">
          <div>
            <strong>Environment</strong>
            <p>Development / Hackathon</p>
          </div>

          <span className="settings-badge">
            DEVNET
          </span>
        </div>

        <div className="settings-row">
          <div>
            <strong>Wallet provider</strong>
            <p>Phantom</p>
          </div>

          <span className="settings-badge">
            Connected when available
          </span>
        </div>

        <div className="settings-row">
          <div>
            <strong>Data persistence</strong>
            <p>Local JSON for development; Supabase migration is staged for production.</p>
          </div>

          <span className="settings-badge">
            Local only
          </span>
        </div>
      </section>
    </div>
  );
}

export default function Home() {
const [active, setActive] = useState("Overview");

  const [products, setProducts] = useState<Product[]>([]);
  const [orders, setOrders] = useState<DashboardOrder[]>([]);

  const [loadError, setLoadError] = useState("");
  const [isLoading, setIsLoading] = useState(true);

  const [showCreateProduct, setShowCreateProduct] = useState(false);

  const [productForm, setProductForm] = useState({
    name: "",
    description: "",
    priceUsdc: "",
    inventory: "",
    imageUrl: "",
    variants: [] as ProductFormVariant[],
  });

  const [copiedProductId, setCopiedProductId] = useState("");

  const [selectedProduct, setSelectedProduct] = useState<Product | null>(
    null,
  );

  const [connected, setConnected] = useState(false);
  const [walletAddress, setWalletAddress] = useState("");

  const [paymentStatus, setPaymentStatus] = useState<
    | "idle"
    | "connecting"
    | "creating"
    | "signing"
    | "sending"
    | "confirming"
    | "paid"
    | "failed"
  >("idle");

  const [paymentMessage, setPaymentMessage] = useState("");
  const [paymentReceipt, setPaymentReceipt] = useState<{
    orderId: string;
    signature: string;
  } | null>(null);

  const [quantity, setQuantity] = useState(1);
  const [selectedVariant, setSelectedVariant] = useState("");


  /**
   * Load products + orders from backend.
   *
   * This function is intentionally reusable so we can refresh
   * the dashboard after creating a product or completing payment.
   */
const fetchDashboardData = useCallback(async () => {
  const [productsResponse, ordersResponse] = await Promise.all([
    fetch("/api/products", {
      cache: "no-store",
    }),
    fetch("/api/orders", {
      cache: "no-store",
    }),
  ]);

  if (!productsResponse.ok || !ordersResponse.ok) {
    throw new Error("Unable to load dashboard data");
  }

  const productData = (await productsResponse.json()) as {
    products: ApiProduct[];
  };

  const orderData = (await ordersResponse.json()) as {
    orders: ApiOrder[];
  };

  const loadedProducts = productData.products.map(toProduct);

  const productNames = new Map(
    loadedProducts.map((product) => [
      product.id,
      product.name,
    ]),
  );

  const loadedOrders: DashboardOrder[] =
    orderData.orders.map((order) => ({
      id: order.id,
      product:
        productNames.get(order.productId) ||
        order.productId,
      buyer: order.buyerWallet,
      amount: order.amountUsdc,
      status:
        order.status.charAt(0).toUpperCase() +
        order.status.slice(1),
      time: new Date(
        order.createdAt,
      ).toLocaleString(),
      variant: order.variant,
      quantity: order.quantity,
      txSignature: order.txSignature,
    }));

  return {
    products: loadedProducts,
    orders: loadedOrders,
  };
}, []);

const loadDashboard = useCallback(async () => {
  try {
    setLoadError("");

    const data = await fetchDashboardData();

    setProducts(data.products);
    setOrders(data.orders);
  } catch (error) {
    setLoadError(
      error instanceof Error
        ? error.message
        : "Unable to load dashboard data",
    );
  } finally {
    setIsLoading(false);
  }
}, [fetchDashboardData]);

useEffect(() => {
  let cancelled = false;

  void fetchDashboardData()
    .then((data) => {
      if (cancelled) {
        return;
      }

      setProducts(data.products);
      setOrders(data.orders);
      setLoadError("");
      setIsLoading(false);
    })
    .catch((error: unknown) => {
      if (cancelled) {
        return;
      }

      setLoadError(
        error instanceof Error
          ? error.message
          : "Unable to load dashboard data",
      );
      setIsLoading(false);
    });

  return () => {
    cancelled = true;
  };
}, [fetchDashboardData]);

useEffect(() => {
  const requestedView = new URLSearchParams(window.location.search).get("view");
  if (
    requestedView === "Products" ||
    requestedView === "Orders" ||
    requestedView === "Blink links" ||
    requestedView === "Settings"
  ) {
    const timer = window.setTimeout(() => setActive(requestedView), 0);
    return () => window.clearTimeout(timer);
  }
}, []);

  const navigateTo = (view: string) => {
    setActive(view);

    const url = new URL(window.location.href);

    if (view === "Overview") {
      url.searchParams.delete("view");
    } else {
      url.searchParams.set("view", view);
    }

    window.history.pushState({}, "", url);
  };

  /**
   * Open the internal web checkout modal.
   * Useful for quickly testing payment from the merchant dashboard.
   */
  const openCheckout = (product: Product) => {
    setSelectedProduct(product);
    setConnected(false);
    setWalletAddress("");
    setPaymentStatus("idle");
    setPaymentMessage("");
    setPaymentReceipt(null);

    const firstAvailableVariant = product.variants.find(
      (variant) => variant.inventory > 0,
    );

    if (product.variants.length > 0) {
      setSelectedVariant(firstAvailableVariant?.value || "");
      setQuantity(firstAvailableVariant ? 1 : 0);
    } else {
      setSelectedVariant("");
      setQuantity(product.inventory > 0 ? 1 : 0);
    }
  };

  /**
   * Create product through backend.
   */
  const createProduct = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    setLoadError("");

    try {
      const variants =
        productForm.variants.length > 0
          ? productForm.variants.map((variant) => ({
              name: variant.name.trim(),
              value: variant.value.trim(),
              inventory: Number(variant.inventory),
            }))
          : undefined;

      const inventory =
        variants && variants.length > 0
          ? variants.reduce(
              (total, variant) => total + variant.inventory,
              0,
            )
          : Number(productForm.inventory);

      const response = await fetch("/api/products", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: productForm.name.trim(),
          description: productForm.description.trim(),
          priceUsdc: Number(productForm.priceUsdc),
          inventory,
          imageUrl: productForm.imageUrl.trim(),
          variants,
        }),
      });

      const data = (await response.json()) as {
        product?: ApiProduct;
        error?: string;
      };

      if (!response.ok || !data.product) {
        throw new Error(data.error || "Unable to create product");
      }

      /**
       * Update the UI immediately.
       * Then refresh from backend in the background.
       */
      setProducts((current) => [
        toProduct(data.product as ApiProduct),
        ...current.filter(
          (product) => product.id !== data.product?.id,
        ),
      ]);

      void loadDashboard();

      setProductForm({
        name: "",
        description: "",
        priceUsdc: "",
        inventory: "",
        imageUrl: "",
        variants: [],
      });

      setShowCreateProduct(false);
    } catch (error) {
      setLoadError(
        error instanceof Error
          ? error.message
          : "Unable to create product",
      );
    }
  };

  const variantInventory = productForm.variants.reduce(
    (total, variant) => total + Number(variant.inventory || 0),
    0,
  );

  const addProductVariant = () => {
    setProductForm((current) => ({
      ...current,
      variants: [
        ...current.variants,
        {
          name: "Size",
          value: "",
          inventory: "",
        },
      ],
    }));
  };

  const updateProductVariant = (
    index: number,
    field: keyof ProductFormVariant,
    value: string,
  ) => {
    setProductForm((current) => ({
      ...current,
      variants: current.variants.map((variant, variantIndex) =>
        variantIndex === index
          ? {
              ...variant,
              [field]: value,
            }
          : variant,
      ),
    }));
  };

  const removeProductVariant = (index: number) => {
    setProductForm((current) => ({
      ...current,
      variants: current.variants.filter(
        (_, variantIndex) => variantIndex !== index,
      ),
    }));
  };

  /**
   * Copy fallback/Blink URL.
   */
  const copyBlinkUrl = async (productId: string) => {
    try {
      const blinkUrl = `${window.location.origin}/blink/${productId}`;

      await navigator.clipboard.writeText(blinkUrl);

      setCopiedProductId(productId);

      window.setTimeout(() => {
        setCopiedProductId("");
      }, 1800);
    } catch {
      setLoadError(
        "Unable to copy the Blink link. Please copy it manually.",
      );
    }
  };

  /**
   * Open the actual Blink/fallback URL.
   *
   * This is the button that should be used for the real Blink flow.
   */
  const openBlinkUrl = (productId: string) => {
    const blinkUrl = `${window.location.origin}/blink/${productId}`;

    window.open(
      blinkUrl,
      "_blank",
      "noopener,noreferrer",
    );
  };

  const connectWallet = async () => {
  const wallet = getSolanaProvider();

  if (!wallet) {
    setPaymentStatus("failed");
    setPaymentMessage(
      "No Solana wallet found. Please install or enable Phantom, then refresh the page.",
    );
    return;
  }

  setPaymentStatus("connecting");
  setPaymentMessage("Connecting to Phantom...");

  try {
    const response = await wallet.connect();

    const address =
      response.publicKey?.toString() ||
      wallet.publicKey?.toString();

    if (!address) {
      throw new Error("Wallet address was not returned");
    }

    setWalletAddress(address);
    setConnected(true);
    setPaymentStatus("idle");
    setPaymentMessage("");
  } catch (error) {
    setPaymentStatus("failed");
    setPaymentMessage(paymentErrorMessage(error));
  }
};

  const disconnectWallet = () => {
    setConnected(false);
    setWalletAddress("");
    setPaymentStatus("idle");
    setPaymentMessage("");
  };

  /**
   * Current max quantity for the selected product/variant.
   */
  const selectedVariantInventory =
    selectedProduct && selectedVariant
      ? selectedProduct.variants.find(
          (variant) => variant.value === selectedVariant,
        )?.inventory
      : undefined;

  const maxQuantity =
    selectedProduct?.variants.length
      ? selectedVariantInventory ?? 0
      : selectedProduct?.inventory ?? 0;

  const payForProduct = async () => {
    if (!selectedProduct || !walletAddress) {
      return;
    }

    if (quantity <= 0 || quantity > maxQuantity) {
      setPaymentStatus("failed");
      setPaymentMessage(
        "The selected quantity is no longer available.",
      );
      return;
    }

    const wallet = getSolanaProvider();

    if (!wallet) {
      setPaymentStatus("failed");
      setPaymentMessage(
        "Your wallet is no longer available. Reconnect and try again.",
      );
      return;
    }

    try {
      setPaymentStatus("creating");
      setPaymentMessage(
        "Preparing payment...",
      );

      const actionResponse = await fetch(
        `/api/actions/product/${selectedProduct.id}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            account: walletAddress,
            quantity,
            ...(selectedVariant
              ? { variant: selectedVariant }
              : {}),
          }),
        },
      );

      const action = (await actionResponse.json()) as {
        transaction?: string;
        orderId?: string;
        message?: string;
      };

      if (
        !actionResponse.ok ||
        !action.transaction ||
        !action.orderId
      ) {
        throw new Error(
          action.message ||
            "Unable to create payment transaction",
        );
      }

      setPaymentStatus("signing");
      setPaymentMessage(
        "Waiting for signature...",
      );

      const transaction = Transaction.from(
        Uint8Array.from(
          atob(action.transaction),
          (character) => character.charCodeAt(0),
        ),
      );

      let signature: string;

if (wallet.signAndSendTransaction) {
  const result =
    await wallet.signAndSendTransaction(
      transaction,
    );

  signature = result.signature;
  setPaymentStatus("sending");
  setPaymentMessage("Sending payment...");
} else {
  const signedTransaction =
    await wallet.signTransaction(
      transaction,
    );

  setPaymentStatus("sending");
  setPaymentMessage(
    "Sending payment to Solana...",
  );

  if (!wallet.sendRawTransaction) {
    throw new Error(
      "This Solana wallet does not support sending transactions.",
    );
  }

  signature =
    await wallet.sendRawTransaction(
      signedTransaction.serialize(),
    );
}

      setPaymentStatus("confirming");
      setPaymentMessage(
        "Confirming payment...",
      );

      let confirmationResponse: Response | undefined;
      let confirmation: {
        error?: string;
        message?: string;
      } = {};

      /**
       * The backend can temporarily return 202 while
       * Solana/RPC confirmation is still propagating.
       */
      for (let attempt = 0; attempt < 3; attempt += 1) {
        confirmationResponse = await fetch(
          "/api/orders/confirm",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              orderId: action.orderId,
              txSignature: signature,
            }),
          },
        );

        confirmation =
          (await confirmationResponse.json()) as {
            error?: string;
            message?: string;
          };

        if (confirmationResponse.ok) {
          break;
        }

        if (
          confirmationResponse.status !== 202 ||
          attempt === 2
        ) {
          throw new Error(
            confirmation.error ||
              confirmation.message ||
              "Payment confirmation failed",
          );
        }

        setPaymentMessage(
          "Payment submitted. Waiting for Solana confirmation...",
        );

        await new Promise((resolve) =>
          setTimeout(resolve, 1500),
        );
      }

      if (!confirmationResponse?.ok) {
        throw new Error(
          confirmation.error ||
            confirmation.message ||
            "Payment confirmation failed",
        );
      }

      setPaymentStatus("paid");
      setPaymentMessage(
        `Order ${action.orderId} is confirmed on Solana.`,
      );
      setPaymentReceipt({ orderId: action.orderId, signature });

      /**
       * Refresh dashboard in the background.
       *
       * Important:
       * A refresh failure must NOT turn a successful
       * blockchain payment into a failed payment UI.
       */
      void loadDashboard();
    } catch (error) {
      setPaymentStatus("failed");
      setPaymentMessage(paymentErrorMessage(error));
    }
  };

  /**
   * Real dashboard statistics.
   */
  const paidOrders = orders.filter(
    (order) => order.status.toLowerCase() === "paid",
  );

  const totalSales = paidOrders.reduce(
    (total, order) => total + order.amount,
    0,
  );

  const totalSalesLabel = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(totalSales);

  const now = new Date();

const todayLabel = new Intl.DateTimeFormat("en-US", {
  weekday: "long",
  month: "long",
  day: "numeric",
  year: "numeric",
  timeZone: "Asia/Ho_Chi_Minh",
}).format(now).toUpperCase();

const currentHour = Number(
  new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    hour12: false,
    timeZone: "Asia/Ho_Chi_Minh",
  }).format(now),
);

const greeting =
  currentHour < 12
    ? "Good morning"
    : currentHour < 18
      ? "Good afternoon"
      : "Good evening";

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">B</span>
          <span>blinkshop</span>
        </div>

        <div className="workspace-switcher">
          <span className="avatar">A</span>

          <span>
            <b>Aria Studio</b>
            <small>Merchant workspace</small>
          </span>

          <span className="chevron">⌄</span>
        </div>

        <nav className="main-nav">
          <p className="nav-label">Workspace</p>

          {[
            ["Overview", "◒"],
            ["Products", "□"],
            ["Orders", "≡"],
            ["Blink links", "↗"],
          ].map(([label, icon]) => (
            <button
              className={`nav-item ${
                active === label ? "active" : ""
              }`}
              key={label}
              onClick={() => navigateTo(label)}
            >
              <Icon>{icon}</Icon>
              {label}

              {label === "Orders" && (
                <span className="nav-count">
                  {orders.length}
                </span>
              )}
            </button>
          ))}

          <p className="nav-label nav-label-spaced">
            Manage
          </p>

          <button
            className={`nav-item ${
              active === "Settings" ? "active" : ""
            }`}
            onClick={() => navigateTo("Settings")}
          >
            <Icon>⚙</Icon>
            Settings
          </button>
        </nav>

        <div className="sidebar-bottom">
          <div className="credit-row">
            <span className="solana-dot" />
            Devnet connected
            <span className="live-dot" />
          </div>

          <div className="help-row">
            ?
            <span>Help center</span>
            <span className="version">v0.1 beta</span>
          </div>
        </div>
      </aside>

      <section className="content-area">
        <header className="topbar">
          <div className="breadcrumb">
            Workspace <span>/</span>{" "}
            <strong>{active}</strong>
          </div>

          <div className="top-actions">
            <button
              className="icon-button"
              aria-label="Notifications"
            >
              ♧
              <span className="notification-dot" />
            </button>

            <button className="profile-button">
              <span className="avatar small">A</span>
              <span>Aria</span>
              <span>⌄</span>
            </button>
          </div>
        </header>

        {active === "Settings" ? (
          <SettingsView />
        ) : active === "Products" ||
          active === "Orders" ||
          active === "Blink links" ? (
          <DashboardViews
            active={active}
            products={products}
            orders={orders}
            onProductsChange={(updatedProducts) =>
              setProducts(
                updatedProducts.map((product) => ({
                  ...product,
                  color:
                    products.find(
                      (current) =>
                        current.id === product.id,
                    )?.color || "#e9c2a9",
                })),
              )
            }
            onCreateProduct={() =>
              setShowCreateProduct(true)
            }
          />
        ) : (
          <div className="content-inner">
            <div className="page-heading">
              <div>
                <p className="eyebrow">
                  {todayLabel || "BLINKSHOP"}
                </p>

                <h1>
                  {greeting}, Aria
                  <span className="heading-period">
                    .
                  </span>
                </h1>

                <p className="subheading">
                  Your social commerce is moving.
                </p>
              </div>

              <button
                className="primary-button"
                onClick={() =>
                  setShowCreateProduct(true)
                }
              >
                <span>＋</span> Create product
              </button>
            </div>

            <section className="stats-grid">
              <article className="stat-card">
                <div className="stat-top">
                  <span>Total sales</span>
                  <span className="stat-icon mint">
                    ↗
                  </span>
                </div>

                <strong>
                  {totalSalesLabel} <small>USDC</small>
                </strong>

                <div className="stat-foot">
                  <span>
                    Confirmed payments
                  </span>
                </div>
              </article>

              <article className="stat-card">
                <div className="stat-top">
                  <span>Orders</span>
                  <span className="stat-icon lemon">
                    ◌
                  </span>
                </div>

                <strong>{orders.length}</strong>

                <div className="stat-foot">
                  <span>
                    All checkout orders
                  </span>
                </div>
              </article>

              <article className="stat-card">
                <div className="stat-top">
                  <span>Products</span>
                  <span className="stat-icon lilac">
                    ⌁
                  </span>
                </div>

                <strong>{products.length}</strong>

                <div className="stat-foot">
                  <span>
                    Merchant catalog
                  </span>
                </div>
              </article>
            </section>

            <section className="feature-band">
              <div className="feature-copy">
                <span className="feature-kicker">
                  BLINK TIP 01
                </span>

                <h2>
                  Turn attention
                  <br />
                  <i>into action.</i>
                </h2>

                <p>
                  Your products are ready to be shared.
                  <br />
                  Make every post shoppable.
                </p>

                <button
                  className="dark-button"
                  onClick={() =>
                    navigateTo("Blink links")
                  }
                >
                  Explore blink links{" "}
                  <span>↗</span>
                </button>
              </div>

              <div className="feature-art">
                <div className="orbit orbit-one" />
                <div className="orbit orbit-two" />

                <div className="art-card">
                  <span className="art-badge">
                    LIVE
                  </span>

                  <div className="art-image" />

                  <div className="art-meta">
                    <strong>{products[0]?.name || "Your next drop"}</strong>

                    <span>
                      {products[0] ? `${formatUsdc(products[0].price)} USDC` : "Share a Blink"} <b>↗</b>
                    </span>
                  </div>
                </div>

                <span className="art-caption">
                  SHAREABLE
                  <br />
                  CHECKOUT
                </span>
              </div>
            </section>

            {loadError && (
              <p className="inline-alert error" role="alert">
                {loadError}
              </p>
            )}

            {isLoading && (
              <div className="loading-panel" role="status">Loading your catalog and orders…</div>
            )}

            <div className="section-header">
              <div>
                <h2 className="section-title">
                  Your products
                </h2>

                <p className="section-description">
                  Products currently available through
                  your Blinks.
                </p>
              </div>

              <button
                className="text-button"
                onClick={() =>
                  navigateTo("Products")
                }
              >
                View all <span>→</span>
              </button>
            </div>

            {!isLoading && <section className="product-grid">
              {products.length === 0 ? (
                <article className="product-card">
                  <div className="product-info">
                    <div>
                      <h3>No products yet</h3>
                      <p>
                        Create your first product to
                        start sharing a Blink.
                      </p>
                    </div>

                    <div className="product-actions">
                      <button
                        className="buy-button"
                        onClick={() =>
                          setShowCreateProduct(true)
                        }
                      >
                        Create product{" "}
                        <span>↗</span>
                      </button>
                    </div>
                  </div>
                </article>
              ) : (
                products.map((product) => (
                  <article
                    className="product-card"
                    key={product.id}
                  >
                    <div
                      className="product-image"
                      style={{
                        backgroundColor:
                          product.color,
                      }}
                    >
                      <div
                        className="product-image-fill"
                        role="img"
                        aria-label={product.name}
                        style={product.image ? { backgroundImage: `url(${product.image})` } : undefined}
                      />

                      <span
                        className={`status-pill ${product.status.toLowerCase().replaceAll(" ", "-")}`}
                      >
                        <i />
                        {product.status}
                      </span>

                    </div>

                    <div className="product-info">
                      <div>
                        <h3>{product.name}</h3>

                        <p>
                          {formatUsdc(product.price)} USDC{" "}
                          <span>·</span>{" "}
                          {product.inventory} in stock
                        </p>
                      </div>

                      <div className="product-actions">
                        <button
                          className="buy-button"
                          onClick={() =>
                            openBlinkUrl(
                              product.id,
                            )
                          }
                        >
                          Open Blink{" "}
                          <span>↗</span>
                        </button>

                        <button
                          className="buy-button"
                          type="button"
                          disabled={product.inventory <= 0}
                          onClick={() =>
                            openCheckout(product)
                          }
                        >
                          Quick pay{" "}
                          <span>↗</span>
                        </button>

                        <button
                          className="buy-button"
                          onClick={() =>
                            void copyBlinkUrl(
                              product.id,
                            )
                          }
                        >
                          {copiedProductId ===
                          product.id
                            ? "Copied"
                            : "Copy link"}
                        </button>
                      </div>
                    </div>
                  </article>
                ))
              )}
            </section>}

            <div className="section-header orders-heading">
              <div>
                <h2 className="section-title">
                  Recent orders
                </h2>

                <p className="section-description">
                  The latest activity across your
                  checkout links.
                </p>
              </div>

              <button
                className="text-button"
                onClick={() =>
                  navigateTo("Orders")
                }
              >
                View all <span>→</span>
              </button>
            </div>

            <section className="orders-table">
              <div className="table-row table-head">
                <span>Order</span>
                <span>Product</span>
                <span>Buyer wallet</span>
                <span>Amount</span>
                <span>Status</span>
                <span>Placed</span>
              </div>

              {orders.length === 0 ? (
                <div className="table-row">
                  <span>No orders yet.</span>
                  <span>
                    Your first Blink payment will
                    appear here.
                  </span>
                  <span />
                  <span />
                  <span />
                  <span />
                </div>
              ) : (
                orders.slice(0, 5).map((order) => (
                  <div
                    className="table-row"
                    key={order.id}
                  >
                    <strong>{order.id}</strong>

                    <span>{order.product}</span>

                    <span className="mono">
                      {shortValue(order.buyer)}
                    </span>

                    <span>
                      {order.amount} USDC
                    </span>

                    <span
                      className={`order-status ${order.status.toLowerCase()}`}
                    >
                      <i />
                      {order.status}
                    </span>

                    <span className="muted">
                      {order.time}
                    </span>
                  </div>
                ))
              )}
            </section>
          </div>
        )}
      </section>

      {selectedProduct && (
        <div
          className="modal-backdrop"
          onClick={() =>
            setSelectedProduct(null)
          }
        >
          <section
            className="checkout-modal product-form-modal"
            onClick={(event) =>
              event.stopPropagation()
            }
          >
            <button
              className="close-button"
              type="button"
              aria-label="Close checkout"
              onClick={() =>
                setSelectedProduct(null)
              }
            >
              ×
            </button>

            <div
              className="checkout-visual"
              style={{
                backgroundColor:
                  selectedProduct.color,
              }}
            >
              <div
                className="checkout-image-fill"
                role="img"
                aria-label={selectedProduct.name}
                style={selectedProduct.image ? { backgroundImage: `url(${selectedProduct.image})` } : undefined}
              />

              <span className="checkout-label">
                BLINKSHOP / DEVNET
              </span>
            </div>

            <div className="checkout-content">
              <div className="checkout-eyebrow">
                INSTANT CHECKOUT
              </div>

              <h2>{selectedProduct.name}</h2>

              <p className="checkout-description">
                {selectedProduct.description || "A direct, wallet-native purchase from Aria Studio."}
              </p>

              {selectedProduct.variants.length >
                0 && (
                <div className="choice-row">
                  <span>
                    {
                      selectedProduct.variants[0]
                        .name
                    }
                  </span>

                  <div className="choice-options">
                    {selectedProduct.variants.map(
                      (variant) => (
                        <button
                          className={`choice ${
                            selectedVariant ===
                            variant.value
                              ? "selected"
                              : ""
                          }`}
                          key={variant.id}
                          type="button"
                          disabled={
                            variant.inventory <= 0
                          }
                          onClick={() => {
                            if (
                              variant.inventory <= 0
                            ) {
                              return;
                            }

                            setSelectedVariant(
                              variant.value,
                            );

                            setQuantity(1);
                          }}
                        >
                          {variant.value}

                          {variant.inventory <= 0 &&
                            " · Sold out"}
                        </button>
                      ),
                    )}
                  </div>
                </div>
              )}

              <div className="quantity-row">
                <span>Quantity</span>

                <div className="quantity-control">
                  <button
                    type="button"
                    aria-label="Decrease quantity"
                    disabled={
                      quantity <= 1 ||
                      maxQuantity <= 0 ||
                      paymentStatus ===
                        "creating" ||
                      paymentStatus ===
                        "signing" ||
                      paymentStatus ===
                        "sending" ||
                      paymentStatus ===
                        "confirming"
                    }
                    onClick={() =>
                      setQuantity(
                        Math.max(
                          1,
                          quantity - 1,
                        ),
                      )
                    }
                  >
                    −
                  </button>

                  <b>{quantity}</b>

                  <button
                    type="button"
                    aria-label="Increase quantity"
                    disabled={
                      quantity >=
                        maxQuantity ||
                      maxQuantity <= 0 ||
                      paymentStatus ===
                        "creating" ||
                      paymentStatus ===
                        "signing" ||
                      paymentStatus ===
                        "sending" ||
                      paymentStatus ===
                        "confirming"
                    }
                    onClick={() =>
                      setQuantity(
                        Math.min(
                          maxQuantity,
                          quantity + 1,
                        ),
                      )
                    }
                  >
                    ＋
                  </button>
                </div>
              </div>

              {maxQuantity <= 0 && (
                <p className="payment-message error">
                  This product or selected variant is
                  sold out.
                </p>
              )}

              {maxQuantity > 0 && (
                <p className="payment-message">
                  {maxQuantity} available
                </p>
              )}

              <div className="checkout-total">
                <span>Total</span>

                <strong>
                  {selectedProduct.price *
                    quantity > 0 ? formatUsdc(selectedProduct.price * quantity) : "0.00"}{" "}
                  <small>USDC</small>
                </strong>
              </div>

              {paymentStatus === "paid" ? (
                <div className="payment-success payment-receipt" role="status">
                  <div className="success-heading"><span>✓</span><div><strong>Payment confirmed</strong><p>Your order is paid on Solana Devnet.</p></div></div>
                  <dl>
                    <div><dt>Order ID</dt><dd>{paymentReceipt?.orderId || "Confirmed"}</dd></div>
                    <div><dt>Amount</dt><dd>{formatUsdc(selectedProduct.price * quantity)} USDC</dd></div>
                    {selectedVariant && <div><dt>Variant</dt><dd>{selectedVariant}</dd></div>}
                    <div><dt>Quantity</dt><dd>{quantity}</dd></div>
                    <div><dt>Wallet</dt><dd className="mono">{walletAddress.slice(0, 5)}…{walletAddress.slice(-5)}</dd></div>
                  </dl>
                  <div className="receipt-actions">
                    <button className="secondary-button" type="button" onClick={() => { setSelectedProduct(null); navigateTo("Orders"); }}>View orders</button>
                    {paymentReceipt?.signature && <a className="secondary-button" href={`https://explorer.solana.com/tx/${paymentReceipt.signature}?cluster=devnet`} target="_blank" rel="noreferrer">View transaction ↗</a>}
                  </div>
                </div>
              ) : (
                <>
                  <button
                    className="checkout-button"
                    type="button"
                    disabled={
                      maxQuantity <= 0 ||
                      quantity <= 0 ||
                      paymentStatus ===
                        "connecting" ||
                      paymentStatus ===
                        "creating" ||
                      paymentStatus ===
                        "signing" ||
                      paymentStatus ===
                        "sending" ||
                      paymentStatus ===
                        "confirming"
                    }
                    onClick={
                      connected
                        ? payForProduct
                        : connectWallet
                    }
                  >
                    {maxQuantity <= 0
                      ? "Out of stock"
                      : paymentStatus ===
                    "connecting"
                        ? "Connecting wallet..."
                      : paymentStatus ===
                          "creating"
                        ? "Preparing payment..."
                        : paymentStatus ===
                            "signing"
                          ? "Waiting for signature..."
                          : paymentStatus ===
                              "sending"
                            ? "Sending payment..."
                            : paymentStatus ===
                                "confirming"
                              ? "Confirming payment..."
                              : connected
                                  ? `Sign & pay ${formatUsdc(selectedProduct.price * quantity)} USDC`
                                : "Connect wallet"}

                    <span>↗</span>
                  </button>

                  {paymentMessage && (
                    <p
                      className={`payment-message ${
                        paymentStatus ===
                        "failed"
                          ? "error"
                          : ""
                      }`}
                    >
                      {paymentMessage}
                    </p>
                  )}
                </>
              )}

              <p className="secure-note">
                <span>◈</span>
                Secured by Solana · USDC on Devnet

                {walletAddress && (
                  <>
                    {" "}
                    ·{" "}
                    {walletAddress.slice(
                      0,
                      4,
                    )}
                    ...
                    {walletAddress.slice(-4)}{" "}

                    <button
                      className="wallet-disconnect"
                      type="button"
                      onClick={
                        disconnectWallet
                      }
                    >
                      Disconnect
                    </button>
                  </>
                )}
              </p>
            </div>
          </section>
        </div>
      )}

      {showCreateProduct && (
        <div
          className="modal-backdrop"
          onClick={() =>
            setShowCreateProduct(false)
          }
        >
          <section
            className="checkout-modal"
            onClick={(event) =>
              event.stopPropagation()
            }
          >
            <button
              className="close-button"
              aria-label="Close product form"
              onClick={() =>
                setShowCreateProduct(false)
              }
            >
              ×
            </button>

            <div className="checkout-content">
              <div className="checkout-eyebrow">
                NEW PRODUCT
              </div>

              <h2>Create product</h2>

              <p className="checkout-description">
                Add an item to your merchant catalog.
              </p>

              <form onSubmit={createProduct}>
                <label>
                  Name

                  <input
                    required
                    value={productForm.name}
                    onChange={(event) =>
                      setProductForm({
                        ...productForm,
                        name: event.target.value,
                      })
                    }
                  />
                </label>

                <label>
                  Description

                  <textarea
                    rows={3}
                    value={
                      productForm.description
                    }
                    onChange={(event) =>
                      setProductForm({
                        ...productForm,
                        description:
                          event.target.value,
                      })
                    }
                  />
                </label>

                <label>
                  Price in USDC

                  <input
                    required
                    min="0.01"
                    step="0.01"
                    type="number"
                    value={
                      productForm.priceUsdc
                    }
                    onChange={(event) =>
                      setProductForm({
                        ...productForm,
                        priceUsdc:
                          event.target.value,
                      })
                    }
                  />
                </label>

                <div className="variant-editor">
                  <div className="variant-editor-header">
                    <span>Variants</span>

                    <button
                      className="text-button"
                      type="button"
                      onClick={
                        addProductVariant
                      }
                    >
                      + Add variant
                    </button>
                  </div>

                  {productForm.variants.map(
                    (variant, index) => (
                      <div
                        className="variant-editor-row"
                        key={`${index}-${variant.value}`}
                      >
                        <input
                          aria-label="Variant group"
                          placeholder="Group"
                          value={
                            variant.name
                          }
                          onChange={(event) =>
                            updateProductVariant(
                              index,
                              "name",
                              event.target
                                .value,
                            )
                          }
                        />

                        <input
                          aria-label="Variant value"
                          placeholder="Value"
                          required
                          value={
                            variant.value
                          }
                          onChange={(event) =>
                            updateProductVariant(
                              index,
                              "value",
                              event.target
                                .value,
                            )
                          }
                        />

                        <input
                          aria-label="Variant inventory"
                          min="0"
                          step="1"
                          required
                          type="number"
                          placeholder="Stock"
                          value={
                            variant.inventory
                          }
                          onChange={(event) =>
                            updateProductVariant(
                              index,
                              "inventory",
                              event.target
                                .value,
                            )
                          }
                        />

                        <button
                          className="text-button danger-text"
                          type="button"
                          aria-label={`Remove ${
                            variant.value ||
                            "variant"
                          }`}
                          onClick={() =>
                            removeProductVariant(
                              index,
                            )
                          }
                        >
                          ×
                        </button>
                      </div>
                    ),
                  )}
                </div>

                <label>
                  Inventory

                  <input
                    required
                    min="0"
                    step="1"
                    type="number"
                    value={
                      productForm.variants.length >
                      0
                        ? variantInventory
                        : productForm.inventory
                    }
                    disabled={
                      productForm.variants.length >
                      0
                    }
                    onChange={(event) =>
                      setProductForm({
                        ...productForm,
                        inventory:
                          event.target.value,
                      })
                    }
                  />

                  {productForm.variants.length >
                    0 && (
                    <small className="field-note">
                      Derived from variant stock
                    </small>
                  )}
                </label>

                <label>
                  Image URL

                  <input
                    type="url"
                    value={
                      productForm.imageUrl
                    }
                    onChange={(event) =>
                      setProductForm({
                        ...productForm,
                        imageUrl:
                          event.target.value,
                      })
                    }
                  />
                </label>

                <button
                  className="checkout-button"
                  type="submit"
                >
                  Create product <span>↗</span>
                </button>
              </form>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
