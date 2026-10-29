import { initializeApp } from "https://www.gstatic.com/firebasejs/13.1.0/firebase-app.js";
import {
  getAuth,
  setPersistence,
  browserSessionPersistence,
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js";
import {
  getFirestore,
  doc,
  collection,
  query,
  where,
  onSnapshot,
  getDoc,
  getDocs,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  deleteDoc
} from "https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js";
import {
  getMessaging,
  getToken,
  deleteToken,
  onMessage,
  isSupported
} from "https://www.gstatic.com/firebasejs/13.1.0/firebase-messaging.js";

const firebaseConfig = {
  apiKey: "AIzaSyBazX3JOri4eDJGRWP1QwiDLEoTYLoOjkI",
  authDomain: "yohan-store-pos.firebaseapp.com",
  projectId: "yohan-store-pos",
  storageBucket: "yohan-store-pos.firebasestorage.app",
  messagingSenderId: "796259422174",
  appId: "1:796259422174:web:b03bb35c13a793e64a574f",
  measurementId: "G-V6W598HYXK"
};

const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
const db = getFirestore(firebaseApp);

// Yohan Store POS - live version.
// Products, requests, sales and costs live in Cloud Firestore.
// Your role comes from the Firestore document users/{your uid}.
// The browser never decides roles. The real protection is firestore.rules.

// Web Push (FCM) public key. This is the PUBLIC key, so it is safe in this file.
// Get it in Firebase Console -> Project settings -> Cloud Messaging ->
// Web Push certificates -> "Generate key pair" (or copy the existing one).
// Paste it between the quotes. Never paste a private key or service-account file here.
const VAPID_PUBLIC_KEY = "BIz9L-bUly_7Wj5u1LAkiYZl3jlgY5y-JH73S0RFC9DXe9k72_sUQx9UPylX1OReOU03JCQ-ZVEZNlhwXwThmxs";

const STORE_TIMEZONE = "Asia/Manila";
const ROLE_NAMES = { admin: "Admin", staff: "Staff", assistant: "Assistant Staff" };

// Which roles may open each page (menu items are hidden for everyone else).
const PAGE_ROLES = {
  cashier: ["admin", "staff", "assistant"],
  inventory: ["admin", "staff"],
  requests: ["admin", "staff", "assistant"],
  reports: ["admin"]
};

// Which roles may do each action (firestore.rules enforces the same table).
const PERMISSIONS = {
  manageProducts: ["admin"],
  viewReports: ["admin"],
  restock: ["admin", "staff"],
  finalizeSales: ["admin", "staff"],
  deleteRequests: ["admin"],
  receiveNotifications: ["admin", "staff"]
};

const data = { products: [], requests: [], sales: [], costs: {} };
let cart = [];
let currentUser = null;
let currentRole = null;
let unsubscribers = [];
let busy = false;
let toastTimer;

// Notification state (see the "Push notifications" section below)
let messaging = null;
let notifSupported = null;   // null = still checking, true / false afterwards
let notifBusy = false;
let stopForeground = null;

const $ = (id) => document.getElementById(id);
const can = (permission) => (PERMISSIONS[permission] || []).includes(currentRole);
const round2 = (n) => Math.round(n * 100) / 100;
const roleName = (role) => ROLE_NAMES[role] || "Unknown";

function formatDateTime(value) {
  return new Date(value).toLocaleString("en-PH", { timeZone: STORE_TIMEZONE });
}

function toISO(value) {
  if (value && typeof value.toDate === "function") return value.toDate().toISOString();
  return value || new Date().toISOString();
}

function money(amount) {
  return Number(amount || 0).toLocaleString("en-PH", {
    style: "currency",
    currency: "PHP"
  });
}

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);
}

function showToast(message, duration = 2800) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.add("show");

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove("show");
  }, duration);
}

function canManageProducts() {
  return can("manageProducts");
}

function canFinalizeSales() {
  return can("finalizeSales");
}

function canDeleteRequests() {
  return can("deleteRequests");
}

// A product is "active" unless it was archived. Older products have no
// "active" field at all, so a missing field means active (no migration needed).
function isActiveProduct(product) {
  return product.active !== false;
}

function getProduct(id) {
  return data.products.find((product) => product.id === id);
}

function getCartTotal() {
  return cart.reduce((total, item) => total + item.price * item.quantity, 0);
}

function getCashReceived() {
  const value = $("cashReceived").value;
  return value === "" ? 0 : Number(value);
}

function getChange() {
  return Math.max(0, getCashReceived() - getCartTotal());
}

function getCartQuantity() {
  return cart.reduce((total, item) => total + item.quantity, 0);
}

function getAvailableStock(productId) {
  const product = getProduct(productId);
  if (!product || !isActiveProduct(product)) return 0;

  const quantityInCart = cart
    .filter((item) => item.productId === productId)
    .reduce((total, item) => total + item.quantity, 0);

  return Math.max(0, product.stock - quantityInCart);
}

// Navigation (only pages the signed-in role may use)
function goToPage(pageId) {
  if (!(PAGE_ROLES[pageId] || []).includes(currentRole)) {
    showToast("You do not have access to that page.");
    return;
  }

  document.querySelectorAll(".page").forEach((page) => {
    page.classList.toggle("active", page.id === pageId);
  });

  document.querySelectorAll(".nav-btn").forEach((button) => {
    button.classList.toggle("active", button.dataset.page === pageId);
  });

  renderAll();
}

document.querySelectorAll(".nav-btn").forEach((button) => {
  button.addEventListener("click", () => goToPage(button.dataset.page));
});

function applyRole() {
  document.body.dataset.role = currentRole || "none";

  document.querySelectorAll(".nav-btn").forEach((button) => {
    button.hidden = !PAGE_ROLES[button.dataset.page].includes(currentRole);
  });

  document.querySelectorAll(".page").forEach((page) => {
    page.hidden = !PAGE_ROLES[page.id].includes(currentRole);
  });

  const isAssistant = currentRole === "assistant";
  $("requestsTitle").textContent = isAssistant ? "My Requests" : "Staff Requests";
  $("requestsSubtitle").textContent = isAssistant
    ? "Track the carts you submitted for approval."
    : "Review Assistant Staff transactions.";

  updateNotifButton();

  const active = document.querySelector(".page.active");
  if (currentRole && active && active.hidden) goToPage("cashier");
}

// Product list
function renderProducts() {
  const search = $("productSearch").value.trim().toLowerCase();

  const products = data.products.filter((product) =>
    isActiveProduct(product) && (
      product.name.toLowerCase().includes(search) ||
      product.id.toLowerCase().includes(search)
    )
  );

  if (products.length === 0) {
    $("productGrid").innerHTML =
      '<div class="empty-state">No matching products found.</div>';
    return;
  }

  $("productGrid").innerHTML = products.map((product) => {
    const available = getAvailableStock(product.id);
    const disabled = available <= 0 ? "disabled" : "";

    return `
      <article class="product-card">
        <h4>${escapeHTML(product.name)}</h4>
        <div class="product-price">${money(product.price)}</div>
        <div class="stock-text">
          ${available} available · ${escapeHTML(product.id)}
        </div>
        <button class="primary-btn add-to-cart"
          data-id="${escapeHTML(product.id)}" ${disabled}>
          ${available > 0 ? "Add to Cart" : "Out of Stock"}
        </button>
      </article>
    `;
  }).join("");
}

$("productSearch").addEventListener("input", renderProducts);

$("productGrid").addEventListener("click", (event) => {
  const button = event.target.closest(".add-to-cart");
  if (!button) return;

  addToCart(button.dataset.id);
});

function addToCart(productId) {
  const product = getProduct(productId);

  if (!product || getAvailableStock(productId) <= 0) {
    showToast("No available stock for this product.");
    return;
  }

  const existing = cart.find((item) => item.productId === productId);

  if (existing) {
    existing.quantity += 1;
  } else {
    cart.push({
      productId: product.id,
      name: product.name,
      price: product.price,
      quantity: 1
    });
  }

  renderAll();
}

function updateCartQuantity(productId, change) {
  const item = cart.find((entry) => entry.productId === productId);
  if (!item) return;

  const product = getProduct(productId);
  if (!product) return;

  const nextQuantity = item.quantity + change;

  if (nextQuantity <= 0) {
    cart = cart.filter((entry) => entry.productId !== productId);
  } else if (change > 0 && !isActiveProduct(product)) {
    showToast("This product was removed from inventory.");
    return;
  } else if (nextQuantity > product.stock) {
    showToast("Quantity cannot exceed available stock.");
    return;
  } else {
    item.quantity = nextQuantity;
  }

  renderAll();
}

$("cartItems").addEventListener("click", (event) => {
  const button = event.target.closest("[data-cart-action]");
  if (!button) return;

  updateCartQuantity(
    button.dataset.id,
    Number(button.dataset.cartAction)
  );
});

function renderCart() {
  $("cartCount").textContent =
    getCartQuantity() + (getCartQuantity() === 1 ? " item" : " items");

  if (cart.length === 0) {
    $("cartItems").innerHTML =
      '<div class="empty-state">Your cart is empty.<br>Add products to begin.</div>';
  } else {
    $("cartItems").innerHTML = cart.map((item) => `
      <div class="cart-line">
        <div class="cart-line-top">
          <span>${escapeHTML(item.name)}</span>
          <span>${money(item.price * item.quantity)}</span>
        </div>
        <div class="cart-line-bottom">
          <span>${money(item.price)} each</span>
          <div class="quantity-controls">
            <button type="button" data-cart-action="-1"
              data-id="${escapeHTML(item.productId)}"
              aria-label="Decrease quantity">−</button>
            <span>${item.quantity}</span>
            <button type="button" data-cart-action="1"
              data-id="${escapeHTML(item.productId)}"
              aria-label="Increase quantity">+</button>
          </div>
        </div>
      </div>
    `).join("");
  }

  $("cartTotal").textContent = money(getCartTotal());
  $("changeAmount").textContent = money(getChange());

  const submitButton = $("submitTransaction");
  submitButton.textContent = currentRole === "assistant"
    ? "Submit for Staff Approval"
    : "Finalize Sale";

  validatePayment();
}

$("cashReceived").addEventListener("input", () => {
  $("changeAmount").textContent = money(getChange());
  validatePayment();
});

function validatePayment() {
  const total = getCartTotal();
  const cash = getCashReceived();
  const message = $("paymentMessage");

  if (cart.length === 0) {
    message.textContent = "Add at least one product.";
    message.className = "message";
    return false;
  }

  if (!$("cashReceived").value.trim() || !Number.isFinite(cash) || cash < 0) {
    message.textContent = "Enter the customer's cash received.";
    message.className = "message error";
    return false;
  }

  if (cash < total) {
    message.textContent = "Insufficient payment. The transaction cannot be submitted.";
    message.className = "message error";
    return false;
  }

  message.textContent = "Payment amount is sufficient.";
  message.className = "message success";
  return true;
}

$("clearCart").addEventListener("click", () => {
  cart = [];
  $("cashReceived").value = "";
  renderAll();
  showToast("Cart cleared.");
});

// Checkout
$("submitTransaction").addEventListener("click", async () => {
  if (busy || !validatePayment()) return;

  for (const item of cart) {
    const product = getProduct(item.productId);
    if (!product || product.stock < item.quantity) {
      showToast("Stock changed. Please check your cart.");
      renderAll();
      return;
    }
  }

  const total = round2(getCartTotal());
  const cash = getCashReceived();
  const items = cart.map(({ productId, name, price, quantity }) => ({
    productId, name, price, quantity
  }));

  busy = true;
  $("submitTransaction").disabled = true;

  try {
    if (currentRole === "assistant") {
      const requestId = await submitRequest(items, total, cash);
      showToast("Request " + requestId + " submitted. Staff must review it.");
    } else if (canFinalizeSales()) {
      const sale = await finalizeSale({ items, cash, sourceRequestId: null });
      showReceipt(sale);
      showToast("Sale finalized. Receipt: " + sale.receipt);
    } else {
      showToast("You do not have permission to finalize sales.");
      return;
    }

    cart = [];
    $("cashReceived").value = "";
  } catch (error) {
    console.error("Checkout failed:", error);
    showToast(error.message || "Could not complete the transaction.");
  } finally {
    busy = false;
    $("submitTransaction").disabled = false;
    renderAll();
  }
});

// Assistant Staff: save a pending request. It is NOT a sale and changes no stock.
async function submitRequest(items, total, cash) {
  const counterRef = doc(db, "counters", "request");

  return runTransaction(db, async (tx) => {
    const counter = await tx.get(counterRef);
    const next = (counter.exists() ? counter.data().n : 0) + 1;
    const id = "REQ-" + String(next).padStart(4, "0");

    tx.set(counterRef, { n: next });
    tx.set(doc(db, "requests", id), {
      assistantUid: currentUser.uid,
      assistantName: currentUser.name,
      items,
      productIds: items.map((item) => item.productId),
      total,
      cash,
      change: round2(cash - total),
      status: "pending",
      reviewedBy: null,
      finalizedBy: null,
      createdAt: serverTimestamp()
    });

    return id;
  });
}

// Staff/Admin: approve or reject a pending request (no income, no stock change).
async function reviewRequest(requestId, newStatus) {
  const ref = doc(db, "requests", requestId);

  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists() || snap.data().status !== "pending") {
      throw new Error("This request is no longer pending.");
    }

    tx.update(ref, {
      status: newStatus,
      reviewedBy: currentUser.name,
      reviewedByUid: currentUser.uid,
      reviewedAt: serverTimestamp()
    });
  });
}

// Admin only: delete a request that never became a sale. The audit record and the
// delete happen in ONE transaction, so you can never get one without the other.
// Completed requests (linked to a sale) are never deleted.
async function deleteRequest(requestId) {
  if (!canDeleteRequests()) throw new Error("Only Admin can delete requests.");

  const ref = doc(db, "requests", requestId);
  const auditRef = doc(db, "auditLogs", "DEL-" + requestId);

  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error("This request no longer exists.");

    const r = snap.data();
    if (!["pending", "approved", "rejected"].includes(r.status) || r.saleReceipt) {
      throw new Error("This request is linked to a completed sale and cannot be deleted.");
    }

    tx.set(auditRef, {
      action: "delete_request",
      requestId,
      requestStatus: r.status,
      requestTotal: r.total,
      requestedBy: r.assistantName,
      by: currentUser.name,
      byUid: currentUser.uid,
      at: serverTimestamp()
    });
    tx.delete(ref);
  });
}

// Staff/Admin: the only place a sale is created. One transaction does it all:
// re-read real prices and stock, deduct stock, write the sale, close the request.
async function finalizeSale({ items, cash, sourceRequestId }) {
  if (!canFinalizeSales()) throw new Error("Only Staff or Admin can finalize sales.");

  return runTransaction(db, async (tx) => {
    let requestRef = null;
    let lines = items;
    let cashReceived = cash;

    // Finishing an approved request: use the SAVED request, not what is on screen.
    if (sourceRequestId) {
      requestRef = doc(db, "requests", sourceRequestId);
      const requestSnap = await tx.get(requestRef);
      if (!requestSnap.exists() || requestSnap.data().status !== "approved") {
        throw new Error("This request is no longer ready to finalize.");
      }
      lines = requestSnap.data().items;
      cashReceived = requestSnap.data().cash;
    }

    // Merge repeated products so each product is checked and deducted exactly once.
    const wanted = new Map();
    for (const line of lines) {
      if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
        throw new Error("Invalid quantity for " + line.name + ".");
      }
      wanted.set(line.productId, (wanted.get(line.productId) || 0) + line.quantity);
    }
    if (wanted.size === 0) throw new Error("There is nothing to sell.");
    if (!Number.isFinite(cashReceived)) throw new Error("Invalid cash amount.");

    const productIds = [...wanted.keys()];
    const productRefs = productIds.map((id) => doc(db, "products", id));
    const productSnaps = await Promise.all(productRefs.map((ref) => tx.get(ref)));
    const receiptRef = doc(db, "counters", "receipt");
    const receiptCounter = await tx.get(receiptRef);

    let total = 0;
    const saleItems = productSnaps.map((snap, index) => {
      const quantity = wanted.get(productIds[index]);
      if (!snap.exists()) throw new Error("A product in this sale no longer exists.");

      const product = snap.data();
      if (product.active === false) {
        throw new Error(product.name + " was removed from inventory. Reject this request or restore the product first.");
      }
      if (product.stock < quantity) {
        throw new Error("Not enough stock for " + product.name + ".");
      }

      total += product.price * quantity;
      return { productId: snap.id, name: product.name, quantity, price: product.price };
    });

    total = round2(total);
    if (cashReceived < total) {
      throw new Error("The cash received does not cover the total of " + money(total) + ".");
    }

    const next = (receiptCounter.exists() ? receiptCounter.data().n : 0) + 1;
    const receipt = "YS-" + String(next).padStart(5, "0");

    productSnaps.forEach((snap, index) => {
      tx.update(productRefs[index], {
        stock: snap.data().stock - saleItems[index].quantity,
        updatedAt: serverTimestamp(),
        lastSaleReceipt: receipt
      });
    });

    tx.set(receiptRef, { n: next, lastReceipt: receipt });
    tx.set(doc(db, "sales", receipt), {
      receipt,
      items: saleItems,
      total,
      cash: cashReceived,
      change: round2(cashReceived - total),
      finalizedBy: currentUser.name,
      finalizedByUid: currentUser.uid,
      finalizedByRole: currentRole,
      sourceRequestId: sourceRequestId || null,
      date: serverTimestamp()
    });

    if (requestRef) {
      tx.update(requestRef, {
        status: "completed",
        finalizedBy: currentUser.name,
        finalizedByUid: currentUser.uid,
        finalizedAt: serverTimestamp(),
        saleReceipt: receipt
      });
    }

    return {
      receipt,
      date: new Date().toISOString(),
      items: saleItems,
      total,
      cash: cashReceived,
      change: round2(cashReceived - total),
      finalizedBy: currentUser.name
    };
  });
}

function showReceipt(sale) {
  const lines = sale.items.map((item) =>
    `${item.name} x${item.quantity} = ${money(item.price * item.quantity)}`
  );

  alert([
    "YOHAN STORE",
    "SALES RECEIPT",
    "Receipt: " + sale.receipt,
    "Date: " + formatDateTime(sale.date),
    "--------------------------------",
    ...lines,
    "--------------------------------",
    "TOTAL: " + money(sale.total),
    "CASH: " + money(sale.cash),
    "CHANGE: " + money(sale.change),
    "Finalized by: " + sale.finalizedBy,
    "",
    "Thank you for shopping!"
  ].join("\n"));
}

// Inventory
function currentCost(productId) {
  const history = data.costs[productId];
  return history && history.length ? history[history.length - 1].cost : null;
}

function renderInventory() {
  const activeProducts = data.products.filter(isActiveProduct);
  const lowStock = activeProducts.filter(
    (product) => product.stock <= product.minStock
  ).length;

  $("inventorySummary").innerHTML = `
    <div class="summary-card">
      <p>Total Products</p>
      <strong>${activeProducts.length}</strong>
    </div>
    <div class="summary-card">
      <p>Units in Stock</p>
      <strong>${activeProducts.reduce((sum, product) => sum + product.stock, 0)}</strong>
    </div>
    <div class="summary-card">
      <p>Low or Out of Stock</p>
      <strong>${lowStock}</strong>
    </div>
  `;

  $("addProductPanel").style.display = canManageProducts() ? "" : "none";

  // Admin also sees archived products (so they can restore them); others do not.
  const visibleProducts = canManageProducts() ? data.products : activeProducts;

  if (visibleProducts.length === 0) {
    $("inventoryTable").innerHTML = `<tr><td colspan="6">No products yet.${
      canManageProducts()
        ? ' <button type="button" class="small-btn" data-product-action="seed">Load 6 sample products</button>'
        : ""
    }</td></tr>`;
    return;
  }

  $("inventoryTable").innerHTML = visibleProducts.map((product) => {
    const archived = !isActiveProduct(product);
    let status = "In Stock";
    let className = "ok";

    if (product.stock === 0) {
      status = "Out of Stock";
      className = "out";
    } else if (product.stock <= product.minStock) {
      status = "Low Stock";
      className = "low";
    }

    if (archived) {
      status = "Archived";
      className = "archived";
    }

    const cost = currentCost(product.id);
    const id = escapeHTML(product.id);
    const actions = [];

    if (archived) {
      if (canManageProducts()) {
        actions.push(`<button type="button" class="small-btn" data-product-action="restore" data-id="${id}">Restore</button>`);
      }
    } else {
      if (can("restock")) {
        actions.push(`<button type="button" class="small-btn" data-product-action="restock" data-id="${id}">Restock</button>`);
      }
      if (canManageProducts()) {
        actions.push(`<button type="button" class="danger-btn small-btn" data-product-action="delete" data-id="${id}">Delete</button>`);
      }
    }

    return `
      <tr>
        <td>${escapeHTML(product.name)} <span class="stock-text">(${id})</span></td>
        <td class="admin-only">${cost === null ? "—" : money(cost)}</td>
        <td>${money(product.price)}</td>
        <td>${product.stock}</td>
        <td><span class="stock-badge ${className}">${status}</span></td>
        <td>${actions.join(" ")}</td>
      </tr>
    `;
  }).join("");
}

// Admin only: one transaction creates the product (no cost) and its private cost record.
async function createProduct({ name, cost, price, stock, minStock }) {
  if (!canManageProducts()) throw new Error("Only Admin can add products.");

  const counterRef = doc(db, "counters", "product");

  return runTransaction(db, async (tx) => {
    const counter = await tx.get(counterRef);
    const next = (counter.exists() ? counter.data().n : 0) + 1;
    const id = "P" + String(next).padStart(3, "0");

    tx.set(counterRef, { n: next });
    tx.set(doc(db, "products", id), {
      name, price, stock, minStock,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    tx.set(doc(db, "productCosts", id), {
      history: [{ from: new Date().toISOString(), cost }]
    });

    return id;
  });
}

$("productForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy) return;

  if (!canManageProducts()) {
    showToast("Only Admin can add products.");
    return;
  }

  const name = $("productName").value.trim();
  const cost = Number($("costPrice").value);
  const price = Number($("sellingPrice").value);
  const stock = Number($("initialStock").value);
  const minStock = Number($("minimumStock").value);

  if (!name || [cost, price, stock, minStock].some((value) =>
    !Number.isFinite(value) || value < 0
  )) {
    showToast("Please enter valid product information.");
    return;
  }

  if (![stock, minStock].every(Number.isInteger)) {
    showToast("Stock and threshold must be whole numbers.");
    return;
  }

  if (data.products.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
    showToast("A product with that name already exists.");
    return;
  }

  busy = true;
  try {
    await createProduct({ name, cost, price, stock, minStock });
    $("productForm").reset();
    $("minimumStock").value = "5";
    showToast("Product added successfully.");
  } catch (error) {
    console.error("Add product failed:", error);
    showToast(error.message || "Could not add the product.");
  } finally {
    busy = false;
  }
});

async function restockProduct(productId) {
  const product = getProduct(productId);
  if (!product) return;

  const answer = prompt(
    `Restock "${product.name}"\nCurrent stock: ${product.stock}\n\nHow many units were added?`
  );
  if (answer === null) return;

  const quantity = Number(answer);
  if (!Number.isInteger(quantity) || quantity <= 0 || quantity > 100000) {
    showToast("Enter a whole number greater than zero.");
    return;
  }

  await runTransaction(db, async (tx) => {
    const ref = doc(db, "products", productId);
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error("This product no longer exists.");

    const before = snap.data().stock;
    const restockRef = doc(collection(db, "restocks"));
    tx.update(ref, {
      stock: before + quantity,
      updatedAt: serverTimestamp(),
      lastRestockId: restockRef.id
    });
    tx.set(restockRef, {
      productId,
      name: snap.data().name,
      quantity,
      previousStock: before,
      newStock: before + quantity,
      byUid: currentUser.uid,
      by: currentUser.name,
      date: serverTimestamp()
    });
  });

  showToast("Restock recorded: +" + quantity + " " + product.name + ".");
}

async function deleteProduct(productId) {
  const product = getProduct(productId);
  if (!product) return;

  // Never delete a product that is part of a request still waiting to be settled.
  const linked = await getDocs(
    query(collection(db, "requests"), where("productIds", "array-contains", productId))
  );
  const open = linked.docs.filter((d) => ["pending", "approved"].includes(d.data().status));

  if (open.length > 0) {
    showToast("Cannot delete: it is in open request(s) " +
      open.map((d) => d.id).join(", ") + ". Finish or reject them first.");
    return;
  }

  const confirmed = confirm(
    `Delete "${product.name}"?\n\nPast sales stay in the reports. This cannot be undone.`
  );
  if (!confirmed) return;

  await runTransaction(db, async (tx) => {
    const productRef = doc(db, "products", productId);
    const costRef = doc(db, "productCosts", productId);
    const costSnap = await tx.get(costRef);

    tx.delete(productRef);
    // Keep the cost history so old sales still show the right profit.
    if (costSnap.exists()) {
      tx.update(costRef, { deleted: true, deletedAt: serverTimestamp() });
    }
  });

  showToast('"' + product.name + '" deleted. Sales history was kept.');
}

// Admin only: SAFE removal. The product is hidden from the cashier and inventory
// counts, but the product record, its cost history and every past sale stay untouched.
async function archiveProduct(productId) {
  if (!canManageProducts()) throw new Error("Only Admin can remove products.");

  const product = getProduct(productId);
  if (!product) throw new Error("That product no longer exists.");
  if (!isActiveProduct(product)) throw new Error("That product is already removed.");

  // Never remove a product that is part of a request still waiting to be settled.
  const linked = await getDocs(
    query(collection(db, "requests"), where("productIds", "array-contains", productId))
  );
  const open = linked.docs.filter((d) => ["pending", "approved"].includes(d.data().status));

  if (open.length > 0) {
    showToast("Cannot remove: it is in open request(s) " +
      open.map((d) => d.id).join(", ") + ". Finish or reject them first.");
    return;
  }

  const confirmed = confirm(
    `Remove "${product.name}" (${product.id}) from inventory?\n\n` +
    "What will happen:\n" +
    "• It disappears from the Cashier and no longer counts in Inventory totals.\n" +
    `• Its ${product.stock} remaining unit(s) can no longer be sold.\n` +
    "• ALL past sales, income and profit reports stay exactly the same.\n" +
    "• Nothing is permanently deleted. You can restore it later from the Inventory page.\n\n" +
    "Continue?"
  );
  if (!confirmed) return;

  await runTransaction(db, async (tx) => {
    const ref = doc(db, "products", productId);
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error("That product no longer exists.");
    if (snap.data().active === false) throw new Error("That product is already removed.");

    tx.update(ref, {
      active: false,
      archivedAt: serverTimestamp(),
      archivedBy: currentUser.name,
      archivedByUid: currentUser.uid,
      updatedAt: serverTimestamp()
    });
  });

  showToast('"' + product.name + '" removed from inventory. Sales history was kept.');
}

async function restoreProduct(productId) {
  if (!canManageProducts()) throw new Error("Only Admin can restore products.");

  const product = getProduct(productId);
  if (!product) throw new Error("That product no longer exists.");

  const confirmed = confirm(
    `Restore "${product.name}" (${product.id})?\n\n` +
    `It will appear in the Cashier again with ${product.stock} unit(s) in stock.`
  );
  if (!confirmed) return;

  await runTransaction(db, async (tx) => {
    const ref = doc(db, "products", productId);
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error("That product no longer exists.");
    if (snap.data().active !== false) throw new Error("That product is not removed.");

    tx.update(ref, {
      active: true,
      restoredAt: serverTimestamp(),
      restoredBy: currentUser.name,
      restoredByUid: currentUser.uid,
      updatedAt: serverTimestamp()
    });
  });

  showToast('"' + product.name + '" restored.');
}

$("inventoryTable").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-product-action]");
  if (!button || busy) return;

  const action = button.dataset.productAction;
  const productId = button.dataset.id;

  busy = true;
  try {
    if (action === "restock") {
      if (!can("restock")) throw new Error("You cannot record restocks.");
      await restockProduct(productId);
    } else if (action === "delete") {
      if (!canManageProducts()) throw new Error("Only Admin can delete products.");
      await deleteProduct(productId);
    } else if (action === "restore") {
      if (!canManageProducts()) throw new Error("Only Admin can restore products.");
      await restoreProduct(productId);
    } else if (action === "seed") {
      if (!canManageProducts()) throw new Error("Only Admin can add products.");
      const samples = [
        ["Instant Noodles", 10, 15, 30, 5], ["Canned Sardines", 18, 25, 20, 5],
        ["Bottled Water", 8, 12, 24, 5], ["Coffee Sachet", 5, 8, 40, 8],
        ["Biscuits", 7, 10, 3, 5], ["Rice 1 kg", 45, 55, 15, 5]
      ];
      for (const [name, cost, price, stock, minStock] of samples) {
        await createProduct({ name, cost, price, stock, minStock });
      }
      showToast("Sample products added.");
    }
  } catch (error) {
    console.error("Product action failed:", error);
    showToast(error.message || "That action failed.");
  } finally {
    busy = false;
  }
});

// Assistant Staff requests
function renderRequests() {
  const canReview = canFinalizeSales();
  const canDelete = canDeleteRequests();

  if (data.requests.length === 0) {
    $("requestList").innerHTML =
      '<div class="empty-state">No requests yet.<br>Assistant Staff can submit a cart for review.</div>';
    return;
  }

  // Filter by the date the request was submitted, in Asia/Manila time.
  const period = $("requestPeriod").value;
  const requests = data.requests.filter((request) => isInReportPeriod(request.createdAt, period));

  if (requests.length === 0) {
    $("requestList").innerHTML =
      '<div class="empty-state">No requests for this period.<br>Try "All dates".</div>';
    return;
  }

  $("requestList").innerHTML = requests.map((request) => {
    const statusLabel = {
      pending: "Pending Review",
      approved: "Approved — Awaiting Finalization",
      rejected: "Rejected",
      completed: "Completed"
    }[request.status] || request.status;

    const itemsHTML = request.items.map((item) =>
      `<li>${escapeHTML(item.name)} × ${item.quantity} — ${money(item.price * item.quantity)}</li>`
    ).join("");

    let actions = "";

    if (canReview && request.status === "pending") {
      actions = `
        <button class="primary-btn" data-request-action="approve"
          data-id="${escapeHTML(request.id)}">Approve Request</button>
        <button class="danger-btn" data-request-action="reject"
          data-id="${escapeHTML(request.id)}">Reject Request</button>
      `;
    } else if (canReview && request.status === "approved") {
      actions = `
        <button class="primary-btn" data-request-action="finalize"
          data-id="${escapeHTML(request.id)}">Verify Payment & Finalize Sale</button>
      `;
    }

    // Only Admin may delete, and never a request that became a sale.
    if (canDelete && request.status !== "completed" && !request.saleReceipt) {
      actions += `
        <button class="danger-btn" data-request-action="delete"
          data-id="${escapeHTML(request.id)}">Delete Request</button>
      `;
    }

    const kindNote = request.status === "completed"
      ? `Completed transaction — sale ${escapeHTML(request.saleReceipt || "")} is recorded in Income Reports.`
      : request.status === "rejected"
        ? "Rejected request — no sale was recorded."
        : "Request only — not a sale yet. No income or stock change until it is finalized.";

    return `
      <article class="request-card">
        <div class="request-header">
          <div>
            <h3>${escapeHTML(request.id)}</h3>
            <p>Submitted by ${escapeHTML(request.assistantName)}</p>
            <p>Submitted: ${formatDateTime(request.createdAt)}</p>
          </div>
          <span class="request-status ${escapeHTML(request.status)}">
            ${escapeHTML(statusLabel)}
          </span>
        </div>

        <ul class="request-products">${itemsHTML}</ul>

        <p><strong>Total:</strong> ${money(request.total)}</p>
        <p><strong>Cash entered:</strong> ${money(request.cash)}</p>
        <p><strong>Change calculated:</strong> ${money(request.change)}</p>
        ${request.reviewedBy ? `<p class="muted">Reviewed by: ${escapeHTML(request.reviewedBy)}${request.reviewedAt ? " · " + formatDateTime(request.reviewedAt) : ""}</p>` : ""}
        ${request.finalizedBy ? `<p class="muted">Finalized by: ${escapeHTML(request.finalizedBy)}${request.finalizedAt ? " · " + formatDateTime(request.finalizedAt) : ""}</p>` : ""}
        <p class="muted"><em>${kindNote}</em></p>

        ${actions ? `<div class="request-actions">${actions}</div>` : ""}
      </article>
    `;
  }).join("");
}

$("requestList").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-request-action]");
  if (!button || busy) return;

  if (!canFinalizeSales()) {
    showToast("Only Staff or Admin can review requests.");
    return;
  }

  const request = data.requests.find((item) => item.id === button.dataset.id);
  if (!request) return;

  const action = button.dataset.requestAction;
  busy = true;
  button.disabled = true;

  try {
    if (action === "approve" || action === "reject") {
      await reviewRequest(request.id, action === "approve" ? "approved" : "rejected");
      showToast(action === "approve"
        ? "Request approved. Verify payment before finalizing."
        : "Request rejected. No sale was recorded.");
    }

    if (action === "delete") {
      if (!canDeleteRequests()) throw new Error("Only Admin can delete requests.");

      const confirmedDelete = confirm(
        `Delete request ${request.id}?\n\n` +
        `Submitted by ${request.assistantName} on ${formatDateTime(request.createdAt)}\n` +
        `Total: ${money(request.total)} · Status: ${request.status}\n\n` +
        "What will happen:\n" +
        "• Only this request is removed. It is NOT a sale.\n" +
        "• No completed sale, income record, stock level or report changes.\n" +
        "• A record of this deletion (who and when) is saved in the audit log.\n" +
        "• This cannot be undone."
      );

      if (confirmedDelete) {
        await deleteRequest(request.id);
        showToast("Request " + request.id + " deleted. Sales and income were not changed.");
      }
    }

    if (action === "finalize") {
      const confirmed = confirm(
        "Have you checked the actual products and confirmed the customer's payment of " +
        money(request.total) + "?\n\nOnly continue if the payment is verified."
      );

      if (confirmed) {
        const sale = await finalizeSale({
          items: request.items,
          cash: request.cash,
          sourceRequestId: request.id
        });
        showReceipt(sale);
        showToast("Sale finalized. Receipt: " + sale.receipt);
      }
    }
  } catch (error) {
    console.error("Request action failed:", error);
    showToast(error.message || "That action failed.");
  } finally {
    busy = false;
    renderAll();
  }
});

$("requestPeriod").addEventListener("change", renderRequests);

// Reports (Admin only; the sales data is never even loaded for other roles)
function storeDateParts(dateValue) {
  const date = new Date(dateValue);
  if (Number.isNaN(date.getTime())) return null;

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: STORE_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  const get = (type) => Number(parts.find((part) => part.type === type).value);
  return { year: get("year"), month: get("month"), day: get("day") };
}

function isInReportPeriod(dateValue, period) {
  const date = storeDateParts(dateValue);
  const now = storeDateParts(new Date());

  if (!date) return false;
  if (period === "all") return true;
  if (period === "year") return date.year === now.year;
  if (period === "month") return date.year === now.year && date.month === now.month;
  if (period === "today") {
    return date.year === now.year && date.month === now.month && date.day === now.day;
  }
  return false;
}

// Cost that applied at the time of the sale (from the Admin-only cost history).
function costAt(productId, saleDate) {
  const history = data.costs[productId];
  if (!history || history.length === 0) return 0;

  let cost = history[0].cost;
  for (const entry of history) {
    if (entry.from <= saleDate) cost = entry.cost;
  }
  return cost;
}

function saleProfit(sale) {
  return sale.items.reduce((sum, item) =>
    sum + (item.price - costAt(item.productId, sale.date)) * item.quantity, 0);
}

// Admin: list of active products that can be removed (archived) from this page.
function renderProductRemoval() {
  const select = $("removeProductSelect");
  const previous = select.value;
  const active = data.products.filter(isActiveProduct);

  select.innerHTML = '<option value="">Choose a product…</option>' + active.map((product) =>
    `<option value="${escapeHTML(product.id)}">${escapeHTML(product.name)} (${escapeHTML(product.id)}) — ${product.stock} in stock</option>`
  ).join("");

  if (active.some((product) => product.id === previous)) select.value = previous;
}

$("removeProductBtn").addEventListener("click", async () => {
  if (busy) return;

  const productId = $("removeProductSelect").value;
  if (!productId) {
    showToast("Choose a product first.");
    return;
  }

  busy = true;
  try {
    if (!canManageProducts()) throw new Error("Only Admin can remove products.");
    await archiveProduct(productId);
  } catch (error) {
    console.error("Remove product failed:", error);
    showToast(error.message || "That action failed.");
  } finally {
    busy = false;
    renderAll();
  }
});

function renderReports() {
  if (!can("viewReports")) {
    $("reportSummary").innerHTML = "";
    $("salesTable").innerHTML = "";
    return;
  }

  renderProductRemoval();

  const period = $("reportPeriod").value;
  const sales = data.sales.filter((sale) => isInReportPeriod(sale.date, period));

  const revenue = sales.reduce((sum, sale) => sum + sale.total, 0);
  const grossProfit = sales.reduce((sum, sale) => sum + saleProfit(sale), 0);
  const itemCount = sales.reduce((sum, sale) =>
    sum + sale.items.reduce((s, item) => s + item.quantity, 0), 0);

  $("reportSummary").innerHTML = `
    <div class="summary-card">
      <p>Sales Revenue</p>
      <strong>${money(revenue)}</strong>
      <small>Finalized sales only</small>
    </div>
    <div class="summary-card">
      <p>Gross Profit</p>
      <strong>${money(grossProfit)}</strong>
      <small>Revenue minus the cost at the time of sale</small>
    </div>
    <div class="summary-card">
      <p>Completed Transactions</p>
      <strong>${sales.length}</strong>
      <small>${itemCount} items sold</small>
    </div>
  `;

  if (sales.length === 0) {
    $("salesTable").innerHTML =
      '<tr><td colspan="6">No completed sales for this period.</td></tr>';
    return;
  }

  $("salesTable").innerHTML = sales.map((sale) => `
    <tr>
      <td>${escapeHTML(sale.receipt)}</td>
      <td>${formatDateTime(sale.date)}</td>
      <td>${sale.items.reduce((sum, item) => sum + item.quantity, 0)}</td>
      <td>${money(sale.total)}</td>
      <td>${money(saleProfit(sale))}</td>
      <td>${escapeHTML(sale.finalizedBy)}</td>
    </tr>
  `).join("");
}

$("reportPeriod").addEventListener("change", renderReports);

// ---------------------------------------------------------------
// Push notifications (Firebase Cloud Messaging)
// - Only Admin and Staff can turn them on (Assistant Staff never gets the button).
// - Permission is asked ONLY when the user clicks the button.
// - Each device saves its token in users/{uid}/devices/{id}. A user can have many devices.
// - The id is a SHA-256 hash of the token, so registering the same device twice
//   just refreshes lastSeenAt instead of creating a duplicate.
// - SENDING notifications is done later by a trusted server (Stage 4), never from here.
// ---------------------------------------------------------------
const SW_URL = new URL("firebase-messaging-sw.js", window.location.href).href;

isSupported()
  .then((ok) => { notifSupported = ok; updateNotifButton(); })
  .catch(() => { notifSupported = false; updateNotifButton(); });

function storeGet(key) {
  try { return localStorage.getItem(key); } catch (error) { return null; }
}
function storeSet(key, value) {
  try { localStorage.setItem(key, value); } catch (error) { /* private mode: ignore */ }
}
function storeRemove(key) {
  try { localStorage.removeItem(key); } catch (error) { /* ignore */ }
}

// Remembers (per user, per browser) which device document belongs to this browser.
const deviceKey = (uid) => "yohanNotifDevice:" + uid;

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(resolve, ms))
  ]);
}

async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function notificationsOn() {
  return Boolean(
    currentUser &&
    "Notification" in window &&
    Notification.permission === "granted" &&
    storeGet(deviceKey(currentUser.uid))
  );
}

function updateNotifButton() {
  const button = $("enableNotifBtn");
  if (!button) return;

  button.hidden = !can("receiveNotifications");
  if (button.hidden) return;

  button.disabled = notifBusy || notifSupported === false;

  if (notifSupported === false) {
    button.textContent = "🔕 Notifications not supported";
  } else if ("Notification" in window && Notification.permission === "denied") {
    button.textContent = "🔕 Notifications blocked";
  } else if (notificationsOn()) {
    button.textContent = "🔔 Notifications on";
  } else {
    button.textContent = "🔔 Enable Notifications";
  }
}

function notifErrorMessage(error) {
  const code = (error && error.code) || "";

  if (code === "app/vapid-missing") {
    return "Notifications are not set up yet: the VAPID key is missing in app.js. Ask the developer to paste it.";
  }
  if (code === "app/vapid-invalid") {
    return "The VAPID key in app.js does not look right. Copy the public key again from Firebase Console.";
  }
  if (code === "app/notifications-unsupported" || code === "messaging/unsupported-browser") {
    return "This browser cannot receive push notifications. On iPhone, add the app to the Home Screen first.";
  }
  if (code === "messaging/permission-blocked" || code === "app/permission-blocked") {
    return "Notifications are blocked for this site. Allow them in your browser's site settings, then try again.";
  }
  if (code === "app/permission-dismissed") {
    return "Notifications were not turned on because the permission box was closed.";
  }
  if (code === "messaging/failed-service-worker-registration") {
    return "Could not start the notification service worker. Check that firebase-messaging-sw.js is uploaded next to index.html.";
  }
  if (code === "messaging/token-subscribe-failed") {
    return "Could not get a notification token. The VAPID key may be wrong, or the Firebase Cloud Messaging API may be disabled.";
  }
  if (code === "permission-denied") {
    return "Could not save this device. Check that the latest Firestore rules are published.";
  }
  if (code === "unavailable" || code === "messaging/token-subscribe-no-token") {
    return "No connection. Check your internet and try again.";
  }
  return "Could not turn on notifications (" + (code || (error && error.message) || "unknown error") + ").";
}

// Gets this browser's FCM token and saves it under the signed-in user.
// askPermission = true only when the user just clicked the button.
async function registerThisDevice(askPermission) {
  if (!currentUser || !can("receiveNotifications")) {
    throw Object.assign(new Error("not allowed"), { code: "app/not-allowed" });
  }
  const uid = currentUser.uid;

  if (!VAPID_PUBLIC_KEY) {
    throw Object.assign(new Error("missing"), { code: "app/vapid-missing" });
  }
  if (!/^[A-Za-z0-9_-]{80,100}$/.test(VAPID_PUBLIC_KEY)) {
    throw Object.assign(new Error("invalid"), { code: "app/vapid-invalid" });
  }

  if (!messaging) {
    if (!(await isSupported())) {
      throw Object.assign(new Error("unsupported"), { code: "app/notifications-unsupported" });
    }
    messaging = getMessaging(firebaseApp);
  }

  if (Notification.permission === "denied") {
    throw Object.assign(new Error("blocked"), { code: "app/permission-blocked" });
  }
  if (Notification.permission !== "granted") {
    if (!askPermission) return;   // never ask without a click
    const result = await Notification.requestPermission();
    if (result === "denied") throw Object.assign(new Error("blocked"), { code: "app/permission-blocked" });
    if (result !== "granted") throw Object.assign(new Error("dismissed"), { code: "app/permission-dismissed" });
  }

  const registration = await navigator.serviceWorker.register(SW_URL);
  await navigator.serviceWorker.ready;

  const token = await getToken(messaging, {
    vapidKey: VAPID_PUBLIC_KEY,
    serviceWorkerRegistration: registration
  });
  if (!token) {
    throw Object.assign(new Error("no token"), { code: "messaging/token-subscribe-no-token" });
  }

  const id = await sha256Hex(token);
  const ref = doc(db, "users", uid, "devices", id);
  const existing = await getDoc(ref);

  if (existing.exists()) {
    await updateDoc(ref, { lastSeenAt: serverTimestamp() });   // duplicate: just refresh
  } else {
    await setDoc(ref, {
      token,
      userAgent: (navigator.userAgent || "").slice(0, 200),
      createdAt: serverTimestamp(),
      lastSeenAt: serverTimestamp()
    });
  }

  // If the browser was given a new token, remove the old record of this browser.
  const previousId = storeGet(deviceKey(uid));
  if (previousId && previousId !== id) {
    deleteDoc(doc(db, "users", uid, "devices", previousId)).catch(() => {});
  }
  storeSet(deviceKey(uid), id);

  listenForForegroundMessages();
}

// Messages that arrive while the app is open and visible.
function listenForForegroundMessages() {
  if (!messaging || stopForeground) return;

  stopForeground = onMessage(messaging, (payload) => {
    if (!currentUser || !can("receiveNotifications")) return;

    const info = payload.data || {};
    const note = payload.notification || {};
    const title = info.title || note.title || "Yohan Store POS";
    const body = info.body || note.body || "";
    showToast(body ? title + " — " + body : title, 8000);
  });
}

// After login: if this browser already allowed notifications, quietly refresh the token.
// This never shows a permission box.
async function refreshNotificationsSilently() {
  try {
    if (!currentUser || !can("receiveNotifications")) return;
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    if (!storeGet(deviceKey(currentUser.uid))) return;

    await registerThisDevice(false);
  } catch (error) {
    console.warn("Could not refresh notifications:", error);
  } finally {
    updateNotifButton();
  }
}

// Turn notifications off for this browser only.
async function disableThisDevice() {
  const uid = currentUser.uid;
  const id = storeGet(deviceKey(uid));

  if (id) await deleteDoc(doc(db, "users", uid, "devices", id));

  if (messaging) {
    try { await deleteToken(messaging); } catch (error) { console.warn("deleteToken:", error); }
  }
  storeRemove(deviceKey(uid));
}

// On log out: stop this account from receiving alerts on this browser
// (the next person to sign in here must not get the previous user's alerts).
async function removeDeviceRecordOnLogout() {
  if (!currentUser) return;
  const id = storeGet(deviceKey(currentUser.uid));
  if (!id) return;

  try {
    await withTimeout(deleteDoc(doc(db, "users", currentUser.uid, "devices", id)), 3000);
  } catch (error) {
    console.warn("Could not remove device record on logout:", error);
  }
}

$("enableNotifBtn").addEventListener("click", async () => {
  if (notifBusy || !can("receiveNotifications")) return;

  notifBusy = true;
  updateNotifButton();

  try {
    if (notificationsOn()) {
      if (confirm("Turn off notifications on this device?\n\nYou will stop receiving store alerts here. You can turn them on again any time.")) {
        await disableThisDevice();
        showToast("Notifications turned off on this device.");
      }
    } else if ("Notification" in window && Notification.permission === "denied") {
      showToast("Notifications are blocked for this site. Allow them in your browser's site settings, then reload.", 6000);
    } else {
      await registerThisDevice(true);
      showToast("Notifications are on for this device.");
    }
  } catch (error) {
    console.error("Notification setup failed:", error);
    showToast(notifErrorMessage(error), 7000);
  } finally {
    notifBusy = false;
    updateNotifButton();
  }
});

// Refresh all visible data.
function renderAll() {
  applyRole();
  renderProducts();
  renderCart();
  renderInventory();
  renderRequests();
  renderReports();
}

renderAll();


const loginForm = document.getElementById("loginForm");
const loginScreen = document.getElementById("loginScreen");
const loginMessage = document.getElementById("loginMessage");
const appLayout = document.querySelector(".app-layout");
const topbar = document.querySelector(".topbar");
const demoNotice = document.querySelector(".demo-notice");

function showLogin() {
  loginScreen.hidden = false;
  appLayout.style.display = "none";
  topbar.style.display = "none";
  demoNotice.style.display = "none";
}

function showPOS() {
  loginScreen.hidden = true;
  loginMessage.textContent = "";
  document.getElementById("loginPassword").value = "";
  appLayout.style.display = "";
  topbar.style.display = "";
  demoNotice.style.display = "";

  $("userName").textContent = currentUser.name;
  $("userRole").textContent = roleName(currentRole);

  goToPage("cashier");
}

function loginErrorMessage(error) {
  switch (error.code) {
    case "auth/invalid-credential":
    case "auth/wrong-password":
    case "auth/user-not-found":
    case "auth/invalid-email":
      return "Wrong email or password. Please try again.";
    case "auth/user-disabled":
      return "This account has been disabled. Ask the Admin.";
    case "auth/too-many-requests":
      return "Too many attempts. Wait a few minutes and try again.";
    case "auth/network-request-failed":
      return "No internet connection. Check your network and try again.";
    case "auth/operation-not-allowed":
      return "Email/Password sign-in is not turned on in Firebase.";
    default:
      return "Sign-in failed (" + (error.code || "unknown error") + ").";
  }
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const submitButton = loginForm.querySelector("button[type='submit']");
  const email = document.getElementById("loginEmail").value.trim();
  const password = document.getElementById("loginPassword").value;

  submitButton.disabled = true;
  loginMessage.textContent = "Signing in...";

  try {
    // Remember the login only until this browser tab is closed.
    await setPersistence(auth, browserSessionPersistence);

    // On success, onAuthStateChanged (below) opens the POS screen.
    await signInWithEmailAndPassword(auth, email, password);
  } catch (error) {
    console.error("Login failed:", error.code, error.message);
    loginMessage.textContent = loginErrorMessage(error);
  } finally {
    submitButton.disabled = false;
  }
});

document.getElementById("logoutBtn").addEventListener("click", async () => {
  try {
    await removeDeviceRecordOnLogout();
    await signOut(auth);
  } catch (error) {
    console.error("Logout failed:", error);
    showToast("Could not log out. Try again.");
  }
});

function profileErrorMessage(error) {
  if (error.message === "no-profile") {
    return "This account has no role yet. Ask the Admin to set it up.";
  }
  if (error.message === "inactive") {
    return "This account is disabled or has an invalid role. Ask the Admin.";
  }
  if (error.code === "permission-denied") {
    return "Could not read your account. Check that the Firestore rules are published.";
  }
  return "Could not load your account (" + (error.code || error.message) + ").";
}

function resetSession() {
  unsubscribers.forEach((stop) => stop());
  unsubscribers = [];
  data.products = [];
  data.requests = [];
  data.sales = [];
  data.costs = {};
  cart = [];
  currentUser = null;
  currentRole = null;
  busy = false;
  $("cashReceived").value = "";
  $("productSearch").value = "";
}

// Start live listeners. Each role only subscribes to what it is allowed to read.
function startListening() {
  const failed = (what) => (error) => {
    console.error("Could not load " + what + ":", error);
    showToast("Could not load " + what + ". You may not have permission.");
  };

  unsubscribers.push(onSnapshot(collection(db, "products"), (snapshot) => {
    data.products = snapshot.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => a.id.localeCompare(b.id));
    renderAll();
  }, failed("products")));

  // Assistant Staff may only read their own requests.
  const requestsQuery = currentRole === "assistant"
    ? query(collection(db, "requests"), where("assistantUid", "==", currentUser.uid))
    : collection(db, "requests");

  unsubscribers.push(onSnapshot(requestsQuery, (snapshot) => {
    data.requests = snapshot.docs
      .map((d) => {
        const r = d.data();
        return {
          id: d.id,
          ...r,
          createdAt: toISO(r.createdAt),
          reviewedAt: r.reviewedAt ? toISO(r.reviewedAt) : null,
          finalizedAt: r.finalizedAt ? toISO(r.finalizedAt) : null
        };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    renderAll();
  }, failed("requests")));

  if (can("viewReports")) {
    unsubscribers.push(onSnapshot(collection(db, "sales"), (snapshot) => {
      data.sales = snapshot.docs
        .map((d) => ({ ...d.data(), receipt: d.id, date: toISO(d.data().date) }))
        .sort((a, b) => b.date.localeCompare(a.date));
      renderAll();
    }, failed("sales")));

    unsubscribers.push(onSnapshot(collection(db, "productCosts"), (snapshot) => {
      data.costs = {};
      snapshot.docs.forEach((d) => { data.costs[d.id] = d.data().history || []; });
      renderAll();
    }, failed("costs")));
  }
}

let authRun = 0;

onAuthStateChanged(auth, async (user) => {
  const run = ++authRun;
  resetSession();

  if (!user) {
    showLogin();
    renderAll();
    return;
  }

  try {
    // The role is read from Firestore (users/{uid}); it can only be written by Admin.
    const snap = await getDoc(doc(db, "users", user.uid));
    if (run !== authRun) return;

    if (!snap.exists()) throw new Error("no-profile");

    const profile = snap.data();
    if (profile.active !== true || !ROLE_NAMES[profile.role]) throw new Error("inactive");

    currentUser = { uid: user.uid, email: user.email, name: profile.name || user.email };
    currentRole = profile.role;

    startListening();
    showPOS();
    refreshNotificationsSilently();
  } catch (error) {
    if (run !== authRun) return;
    console.error("Could not load account:", error);
    loginMessage.textContent = profileErrorMessage(error);
    showLogin();
    await signOut(auth).catch(() => {});
  }
});