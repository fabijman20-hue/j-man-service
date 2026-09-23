"use strict";

// =====================================
// J-NET ZONE SERVICE
// BILINGUAL WEBSITE + ORDER SYSTEM
//
// ORDER FLOW (as of this version):
//   Customer submits the form (file optional)
//     -> if a file was chosen, it's read as base64 in the browser
//     -> the whole order (with or without the file) is POSTed to
//        your Google Apps Script Web App (CONFIG.UPLOAD_ENDPOINT)
//     -> Apps Script (running under YOUR Google account, not the
//        browser) optionally saves the file into a dated Drive
//        folder, logs the order to an auto-created Google Sheet,
//        and emails you (NOTIFY_EMAIL in Code.gs) immediately —
//        automatically, with no click required from the customer.
//     -> the website shows the customer an in-page confirmation.
//
// There is no WhatsApp step and no mailto step in this version —
// notification is fully automatic via email, sent server-side.
//
// See the accompanying Code.gs and its setup notes for what you
// must configure before this works.
// =====================================

(function () {

    // =====================================
    // CONFIG — fill these in. Do not deploy with placeholders left in.
    // =====================================

    const CONFIG = {

        // The Web App URL you get after deploying Code.gs
        // (Deploy > New deployment > Web app). Looks like:
        // https://script.google.com/macros/s/XXXXXXXX/exec
        UPLOAD_ENDPOINT: "https://script.google.com/macros/s/AKfycbwWuv7JYdJ-DBZ4skdvwToizopDpS-1klZlFRKJNMACD7PabQoOmtC85Rq0PLdvAW-FUg/exec",

        // Must exactly match SHARED_TOKEN in Code.gs. Make up any
        // random string — this isn't a login, just a filter so random
        // internet traffic can't hit your endpoint.
        UPLOAD_TOKEN: "-9NZitkpom0spT8-36VqBrHylAYxEvDH",

        // Client-side mirror of the Code.gs limits, so customers get
        // instant feedback instead of waiting on a round trip.
        MAX_FILE_SIZE_BYTES: 15 * 1024 * 1024, // 15 MB
        ALLOWED_MIME_TYPES: [
            "application/pdf",
            "image/jpeg",
            "image/png",
            "application/msword",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        ]

    };

    function isPlaceholder(value) {
        return typeof value === "string" && value.indexOf("PASTE_") === 0;
    }


    // =====================================
    // LIMITS (defense in depth, mirrors HTML constraints)
    // =====================================

    const LIMITS = {
        name: 80,
        phone: 20,
        quantity: 10000,
        message: 1000
    };

    const PHONE_PATTERN = /^[0-9+()\-\s]{6,20}$/;

    const SUBMIT_COOLDOWN_MS = 3000;
    let lastSubmitAt = 0;
    let submitInFlight = false;


    // =====================================
    // CURRENT LANGUAGE
    // =====================================

    let currentLanguage = "fr";

    try {
        const saved = localStorage.getItem("language");
        if (saved === "fr" || saved === "mg") {
            currentLanguage = saved;
        }
    } catch (err) {
        currentLanguage = "fr";
    }


    // =====================================
    // SANITIZATION HELPERS
    // =====================================

    function cleanText(value, maxLength) {

        if (typeof value !== "string") {
            return "";
        }

        const withoutControlChars = value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
        return withoutControlChars.trim().slice(0, maxLength);

    }

    function cleanPhone(value) {
        const cleaned = cleanText(value, LIMITS.phone);
        return PHONE_PATTERN.test(cleaned) ? cleaned : "";
    }

    function cleanQuantity(value) {
        const n = parseInt(value, 10);
        if (!Number.isFinite(n) || n < 1) {
            return "";
        }
        return String(Math.min(n, LIMITS.quantity));
    }


    // =====================================
    // CHANGE LANGUAGE
    // =====================================

    function changeLanguage(language) {

        if (language !== "fr" && language !== "mg") {
            return;
        }

        currentLanguage = language;

        document.querySelectorAll("[data-fr]").forEach(element => {
            const translation = element.getAttribute(`data-${language}`);
            if (translation !== null) {
                element.textContent = translation;
            }
        });

        document.querySelectorAll("[data-placeholder-fr]").forEach(element => {
            const placeholder = element.getAttribute(`data-placeholder-${language}`);
            if (placeholder !== null) {
                element.placeholder = placeholder;
            }
        });

        document.querySelectorAll("option[data-fr]").forEach(option => {
            const translation = option.getAttribute(`data-${language}`);
            if (translation !== null) {
                option.textContent = translation;
            }
        });

        document.documentElement.lang = language;

        try {
            localStorage.setItem("language", language);
        } catch (err) {
            // Ignore storage failures.
        }

        const mgButton = document.getElementById("mgBtn");
        const frButton = document.getElementById("frBtn");

        if (mgButton) {
            mgButton.classList.toggle("active", language === "mg");
        }

        if (frButton) {
            frButton.classList.toggle("active", language === "fr");
        }

    }


    // =====================================
    // SELECT SERVICE
    // =====================================

    function selectService(serviceName) {

        const serviceSelect = document.getElementById("service");

        if (serviceSelect) {
            const option = Array.from(serviceSelect.options).find(
                item => item.value === serviceName
            );
            if (option) {
                serviceSelect.value = serviceName;
            }
        }

        const orderSection = document.getElementById("order");
        if (orderSection) {
            orderSection.scrollIntoView({ behavior: "smooth" });
        }

    }


    // =====================================
    // GET SELECTED SERVICE / PAPER NAME
    // =====================================

    function getOptionName(selectElement) {

        if (!selectElement) {
            return "";
        }

        const selectedOption = selectElement.options[selectElement.selectedIndex];

        if (!selectedOption) {
            return "";
        }

        if (currentLanguage === "fr" && selectedOption.dataset.fr) {
            return selectedOption.dataset.fr;
        }

        return selectedOption.dataset.mg || selectedOption.value;

    }


    // =====================================
    // STATUS BANNER
    // =====================================

    function showStatus(kind, textMg, textFr) {

        const statusEl = document.getElementById("orderStatus");
        if (!statusEl) {
            return;
        }

        statusEl.hidden = false;
        statusEl.classList.remove("status-pending", "status-success", "status-error");
        statusEl.classList.add(`status-${kind}`);
        statusEl.textContent = currentLanguage === "fr" ? textFr : textMg;

    }

    function hideStatus() {
        const statusEl = document.getElementById("orderStatus");
        if (statusEl) {
            statusEl.hidden = true;
        }
    }


    // =====================================
    // FILE -> BASE64
    // =====================================

    function readFileAsBase64(file) {

        return new Promise((resolve, reject) => {

            const reader = new FileReader();

            reader.onload = () => {
                const result = String(reader.result);
                const commaIndex = result.indexOf(",");
                resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
            };

            reader.onerror = () => reject(new Error("file-read-failed"));

            reader.readAsDataURL(file);

        });

    }


    // =====================================
    // SUBMIT ORDER (always contacts the backend, file optional)
    // =====================================

    async function submitOrder(orderInfo, file) {

        const payload = {
            token: CONFIG.UPLOAD_TOKEN,
            name: orderInfo.name,
            phone: orderInfo.phone,
            service: orderInfo.serviceName,
            quantity: orderInfo.quantity,
            paper: orderInfo.paperName,
            message: orderInfo.message
        };

        if (file) {
            payload.fileName = file.name;
            payload.mimeType = file.type || "application/octet-stream";
            payload.fileBase64 = await readFileAsBase64(file);
        }

        // Content-Type: text/plain keeps this a CORS "simple request",
        // avoiding Apps Script's limited support for preflight OPTIONS
        // requests. Code.gs still parses the body as JSON.
        const response = await fetch(CONFIG.UPLOAD_ENDPOINT, {
            method: "POST",
            headers: { "Content-Type": "text/plain;charset=utf-8" },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            throw new Error("submit-http-" + response.status);
        }

        const data = await response.json();

        if (!data.success) {
            throw new Error(data.error || "submit-failed");
        }

        return data;

    }


    // =====================================
    // ORDER FORM SUBMISSION
    // =====================================

    function handleOrderSubmit(event) {

        event.preventDefault();

        const honeypot = document.getElementById("website");
        if (honeypot && honeypot.value.trim() !== "") {
            return;
        }

        const now = Date.now();
        if (submitInFlight || now - lastSubmitAt < SUBMIT_COOLDOWN_MS) {
            return;
        }

        const submitButton = document.querySelector("#orderForm .submit-btn");
        submitInFlight = true;
        lastSubmitAt = now;

        if (submitButton) {
            submitButton.disabled = true;
        }

        processOrder()
            .catch(err => {
                console.error("Order submission failed:", err);
                showStatus(
                    "error",
                    "Nisy olana nitranga tamin'ny fandefasana ny filazanao. Andramo indray, na mifandraisa mivantana aminay.",
                    "Une erreur est survenue lors de l'envoi de votre commande. Veuillez réessayer ou nous contacter directement."
                );
            })
            .finally(() => {
                setTimeout(() => {
                    submitInFlight = false;
                    if (submitButton) {
                        submitButton.disabled = false;
                    }
                }, SUBMIT_COOLDOWN_MS);
            });

    }

    async function processOrder() {

        if (isPlaceholder(CONFIG.UPLOAD_ENDPOINT) || isPlaceholder(CONFIG.UPLOAD_TOKEN)) {

            showStatus(
                "error",
                "Mbola tsy voakasa ity fomba fandefasana ity. Mifandraisa amin'ny tompon'ny tranokala.",
                "Ce formulaire n'est pas encore configuré. Veuillez contacter le propriétaire du site."
            );
            console.error(
                "script.js CONFIG has placeholder values left in it. " +
                "Fill in UPLOAD_ENDPOINT and UPLOAD_TOKEN before going live."
            );
            return;

        }

        const nameField = document.getElementById("name");
        const phoneField = document.getElementById("phone");
        const serviceField = document.getElementById("service");
        const quantityField = document.getElementById("quantity");
        const paperField = document.getElementById("paper");
        const messageField = document.getElementById("message");
        const fileInput = document.getElementById("file");

        const name = cleanText(nameField ? nameField.value : "", LIMITS.name);
        const phoneRaw = phoneField ? phoneField.value : "";
        const service = serviceField ? serviceField.value : "";
        const quantityRaw = quantityField ? quantityField.value : "";
        const message = cleanText(messageField ? messageField.value : "", LIMITS.message);

        const phone = cleanPhone(phoneRaw);
        const quantity = cleanQuantity(quantityRaw);

        if (!name || !phone || !service) {

            showStatus(
                "error",
                phoneRaw.trim() && !phone
                    ? "Ampidiro laharana finday marina."
                    : "Ampidiro ny anaranao sy ny laharana findainao ary safidio ny tolotra iray.",
                phoneRaw.trim() && !phone
                    ? "Veuillez entrer un numéro de téléphone valide."
                    : "Veuillez remplir votre nom, votre numéro de téléphone et choisir un service."
            );
            return;

        }

        const serviceName = cleanText(getOptionName(serviceField), 100);
        const paperName = cleanText(getOptionName(paperField), 100);

        const orderInfo = { name, phone, serviceName, quantity, paperName, message };

        const file = (fileInput && fileInput.files && fileInput.files.length > 0)
            ? fileInput.files[0]
            : null;

        if (file) {

            if (file.size > CONFIG.MAX_FILE_SIZE_BYTES) {
                showStatus(
                    "error",
                    "Be loatra io rakitra io. Misafidiana rakitra kely kokoa.",
                    "Ce fichier est trop volumineux. Veuillez en choisir un plus petit."
                );
                return;
            }

            if (CONFIG.ALLOWED_MIME_TYPES.indexOf(file.type) === -1) {
                showStatus(
                    "error",
                    "Tsy raisina io karazana rakitra io. Ampiasao PDF, JPG, PNG, DOC na DOCX.",
                    "Ce type de fichier n'est pas pris en charge. Utilisez PDF, JPG, PNG, DOC ou DOCX."
                );
                return;
            }

        }

        showStatus(
            "pending",
            file ? "Mampakatra ny rakitrao sy mandefa ny filazanao..." : "Mandefa ny filazanao...",
            file ? "Téléversement de votre fichier et envoi de votre commande..." : "Envoi de votre commande..."
        );

        await submitOrder(orderInfo, file);

        showStatus(
            "success",
            file
                ? "Voaray ny filazanao sy ny rakitrao. Voampahafantatra izahay tamin'ny mailaka ary hifandray aminao tsy ho ela."
                : "Voaray ny filazanao. Voampahafantatra izahay tamin'ny mailaka ary hifandray aminao tsy ho ela.",
            file
                ? "Votre commande et votre fichier ont été reçus. Nous avons été notifiés par e-mail et vous recontacterons."
                : "Votre commande a été reçue. Nous avons été notifiés par e-mail et vous recontacterons."
        );

        const orderForm = document.getElementById("orderForm");
        if (orderForm) {
            orderForm.reset();
        }

    }


    // =====================================
    // WIRE UP EVENT LISTENERS
    // =====================================

    function init() {

        const mgButton = document.getElementById("mgBtn");
        const frButton = document.getElementById("frBtn");

        if (mgButton) {
            mgButton.addEventListener("click", () => changeLanguage("mg"));
        }

        if (frButton) {
            frButton.addEventListener("click", () => changeLanguage("fr"));
        }

        document.querySelectorAll("[data-service]").forEach(button => {
            button.addEventListener("click", () => {
                selectService(button.getAttribute("data-service"));
            });
        });

        const orderForm = document.getElementById("orderForm");

        if (orderForm) {
            orderForm.addEventListener("submit", handleOrderSubmit);
            orderForm.addEventListener("input", hideStatus);
        }

        changeLanguage(currentLanguage);

    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }

})();