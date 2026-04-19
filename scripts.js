// CatalogCore (no DOM) then BuildableUI; data: parts, sets in data.js.
(function (global) {
  "use strict";

  global.CatalogCore = {
    getEra: function (year) {
      if (year === "" || year === null || year === undefined) return null;
      var y = Number(year);
      if (!isFinite(y)) return null;
      if (y < 1990) return "Classic";
      if (y < 2000) return "90s";
      if (y < 2010) return "2000s";
      return "Modern";
    },
    getCompletionPct: function (set, ownedPartIds) {
      if (!set.parts || set.parts.length === 0) return 0;
      var n = 0;
      for (var i = 0; i < set.parts.length; i++) {
        if (ownedPartIds.has(set.parts[i])) n += 1;
      }
      return Math.round((n / set.parts.length) * 100);
    },
    ownedPartsCountInSet: function (set, ownedPartIds) {
      if (!set.parts || set.parts.length === 0) return 0;
      var n = 0;
      for (var i = 0; i < set.parts.length; i++) {
        if (ownedPartIds.has(set.parts[i])) n += 1;
      }
      return n;
    },
    filterSets: function (allSets, filters) {
      var theme = filters.theme;
      var era = filters.era;
      var q = (filters.setQuery || "").trim().toLowerCase();
      var self = this;
      return allSets.filter(function (s) {
        if (theme && s.theme !== theme) return false;
        if (era && self.getEra(s.year) !== era) return false;
        if (q) {
          var nm = s.name.toLowerCase();
          var sid = String(s.id).toLowerCase();
          if (nm.indexOf(q) === -1 && sid.indexOf(q) === -1) return false;
        }
        return true;
      });
    },
    withCompletionPct: function (filteredSets, ownedPartIds) {
      var self = this;
      return filteredSets.map(function (s) {
        return Object.assign({}, s, { pct: self.getCompletionPct(s, ownedPartIds) });
      });
    },

    sortSetsWithPct: function (withPct, sortBy) {
      return withPct.slice().sort(function (a, b) {
        if (sortBy === "pct") return b.pct - a.pct || a.name.localeCompare(b.name);
        if (sortBy === "num_parts") return b.num_parts - a.num_parts || a.name.localeCompare(b.name);
        if (sortBy === "year") return b.year - a.year || a.name.localeCompare(b.name);
        return a.name.localeCompare(b.name);
      });
    },

    matchParts: function (partsCatalog, query, limit) {
      var lim = limit == null ? 150 : limit;
      var q = (query || "").trim().toLowerCase();
      if (!q) {
        return { list: [], truncated: false };
      }
      // exact id first so a pasted id wins over random substring hits
      var exact = null;
      var ei;
      for (ei = 0; ei < partsCatalog.length; ei++) {
        if (String(partsCatalog[ei].id).toLowerCase() === q) {
          exact = partsCatalog[ei];
          break;
        }
      }
      var out = [];
      if (exact) {
        out.push(exact);
      }
      var j;
      for (j = 0; j < partsCatalog.length && out.length < lim; j++) {
        if (exact && partsCatalog[j].id === exact.id) {
          continue;
        }
        var p = partsCatalog[j];
        var hay = (p.name + " " + p.category + " " + p.id).toLowerCase();
        if (hay.indexOf(q) !== -1) {
          out.push(p);
        }
      }
      var truncated = false;
      //capped list might still have more hits later in the file
      if (out.length >= lim) {
        for (; j < partsCatalog.length; j++) {
          if (exact && partsCatalog[j].id === exact.id) {
            continue;
          }
          var p2 = partsCatalog[j];
          var hay2 = (p2.name + " " + p2.category + " " + p2.id).toLowerCase();
          if (hay2.indexOf(q) !== -1) {
            truncated = true;
            break;
          }
        }
      }
      return { list: out, truncated: truncated };
    },

    missingPartIds: function (set, ownedPartIds) {
      if (!set.parts) return [];
      return set.parts.filter(function (pid) {
        return !ownedPartIds.has(pid);
      });
    },
  };
})(typeof window !== "undefined" ? window : this);
(function (global) {
  "use strict";

  var C = global.CatalogCore;
  if (!C) {
    throw new Error("CatalogCore missing — define CatalogCore before BuildableUI in scripts.js");
  }

  var PLACEHOLDER_IMG = "assets/placeholder-set.svg";

  var ownedPartIds = new Set();
  var wishlistBySetId = new Map();
  var partById = new Map();
  var setById = new Map();
  var wishlistOpen = false;
  var ownedChipsExpanded = false;
  var userSets = [];

  // past this, grid is spacer + absolutely positioned cards (viewport only)
  var CATALOG_VIRTUAL_THRESHOLD = 48;
  var CATALOG_ROW_SLOT_PX = 368; // keep in sync with --catalog-card-height
  var CATALOG_GRID_GAP_PX = 12;
  var CATALOG_MIN_CARD_PX = 248;
  var catalogVirtualRows = null;
  var lastCatalogFilterKey = "";
  var lastCatalogMatchCount = -1;
  var lastVirtualPaintKey = "";
  var catalogScrollRaf = 0;
  // bumps when "parts i have" changes — virtual repaint must not reuse old skip keys
  var catalogOwnedEpoch = 0;
  var backToTopRaf = 0;
  var layoutResizeTimer = null;
  var detailModalSetId = null;

  function catalogSets() {
    return sets.concat(userSets);
  }

  function rebuildPartIndex() {
    partById.clear();
    for (var pi = 0; pi < parts.length; pi++) {
      partById.set(parts[pi].id, parts[pi]);
    }
  }

  function rebuildSetIndex() {
    setById.clear();
    var cs = catalogSets();
    for (var si = 0; si < cs.length; si++) {
      setById.set(cs[si].id, cs[si]);
    }
  }

  function findPartMeta(partId) {
    return partById.get(partId);
  }

  function getWishlistEntry(setId) {
    return wishlistBySetId.get(setId);
  }
  function toggleWishlist(setId) {
    if (wishlistBySetId.has(setId)) wishlistBySetId.delete(setId);
    else wishlistBySetId.set(setId, { setId: setId, owned: false });
  }
  function setWishlistOwned(setId, owned) {
    var w = getWishlistEntry(setId);
    if (w) w.owned = owned;
  }

  function findSetById(id) {
    return setById.get(id);
  }

  function setIdImageVariants(setId) {
    var id = String(setId);
    var out = [];
    var seen = {};
    function add(x) {
      if (!seen[x]) {
        seen[x] = true;
        out.push(x);
      }
    }
    add(id);
    var m = id.match(/^(\d+)-(\d+)$/);
    // cdn filenames often exist for the "-1" reissue even when you have "-2"
    if (m && m[2] !== "1") {
      add(m[1] + "-1");
    }
    return out;
  }
  function buildImageUrlCandidates(set) {
    var seen = {};
    var urls = [];
    function push(u) {
      if (!u || seen[u]) return;
      seen[u] = true;
      urls.push(u);
    }
    function pushCdnForVariant(v) {
      push("https://cdn.rebrickable.com/media/sets/" + v + ".jpg");
      push("https://cdn.rebrickable.com/media/sets/" + v.toLowerCase() + ".jpg");
      push("https://cdn.rebrickable.com/media/sets/" + v + ".webp");
      push("https://images.brickset.com/sets/images/" + v + ".jpg");
      push("https://images.brickset.com/sets/small/" + v + ".jpg");
    }

    var variants = setIdImageVariants(set.id);
    var vi;
    var vj;
    var v;
    for (vi = 0; vi < variants.length; vi++) {
      pushCdnForVariant(variants[vi]);
    }
    if (set.image) push(set.image);
    if (set.image_alt) push(set.image_alt);
    for (vj = 0; vj < variants.length; vj++) {
      v = variants[vj];
      push("images/sets/" + v + ".jpg");
      push("images/sets/" + v + ".webp");
      push("images/sets/" + v + ".png");
    }
    push(PLACEHOLDER_IMG);
    return urls;
  }

  function bindSetImage(img, set) {
    img.dataset.boundSetId = String(set.id);
    var urls = buildImageUrlCandidates(set);
    if (!urls.length) {
      img.removeAttribute("src");
      img.src = PLACEHOLDER_IMG;
      return;
    }
    img.referrerPolicy = "no-referrer";
    var i = 0;
    img.onload = function () {
      // good load — don't fall through to the next candidate url
      img.onerror = null;
    };
    img.onerror = function () {
      i += 1;
      if (i < urls.length) {
        img.src = urls[i];
      } else {
        img.onerror = null;
        img.src = PLACEHOLDER_IMG;
      }
    };
    img.src = urls[0];
  }

  function bindSetImageIfNeeded(img, set) {
    if (img.dataset.boundSetId === String(set.id)) return;
    bindSetImage(img, set);
  }

  function getFilters() {
    var setSearch = document.getElementById("set-search");
    return {
      theme: document.getElementById("theme-select").value,
      era: document.getElementById("era-select").value,
      setQuery: (setSearch && setSearch.value) ? setSearch.value.trim() : "",
    };
  }

  function filterKey() {
    var f = getFilters();
    var sortEl = document.getElementById("sort-select");
    var sort = sortEl ? sortEl.value : "name";
    var base = f.theme + "|" + f.era + "|" + f.setQuery + "|" + sort;
    if (sort === "pct") {
      // owned list isn't in the dropdown values — fold it in so filter cache busts
      return base + "|owned:" + String(catalogOwnedEpoch);
    }
    return base;
  }

  function setStatLine(matchCount, catalogTotal) {
    var el = document.getElementById("catalog-stats");
    if (!el) return;
    el.textContent =
      matchCount.toLocaleString() +
      " set" +
      (matchCount === 1 ? "" : "s") +
      " match your filters (" +
      catalogTotal.toLocaleString() +
      " in catalog).";
  }
  function hideBrowseLine() {
    var nav = document.getElementById("catalog-pagination");
    if (nav) nav.classList.add("hidden");
  }

  function setBrowseLine(isVirtual, total, visFrom1, visTo) {
    var nav = document.getElementById("catalog-pagination");
    var status = document.getElementById("catalog-page-status");
    if (!nav || !status) return;
    nav.classList.remove("hidden");
    if (isVirtual) {
      status.textContent =
        "Cards " +
        visFrom1.toLocaleString() +
        "–" +
        visTo.toLocaleString() +
        " of " +
        total.toLocaleString() +
        " in view.";
    } else {
      status.textContent =
        "Showing all " + total.toLocaleString() + " matching set" + (total === 1 ? "" : "s") + ".";
    }
  }

  function queueVirtualPaint() {
    if (!catalogVirtualRows) return;
    if (catalogScrollRaf) return;
    catalogScrollRaf = requestAnimationFrame(function () {
      catalogScrollRaf = 0;
      paintVirtual(false);
    });
  }

  function fillCard(card, s) {
    var img = card.querySelector(".card-img");
    img.alt = s.name + " box art";
    bindSetImageIfNeeded(img, s);

    card.querySelector(".card-title").textContent = s.name;
    card.querySelector(".card-meta").textContent = s.theme + " · " + s.year;
    card.querySelector(".card-set-id").textContent = "Set " + s.id;

    var tracked = s.parts ? s.parts.length : 0;
    var matched = C.ownedPartsCountInSet(s, ownedPartIds);
    var countEl = card.querySelector(".card-count");
    // our parts[] can be a subset of lego's official count — don't imply they're the same
    if (tracked === s.num_parts) {
      countEl.textContent =
        tracked.toLocaleString() +
        " parts · " +
        matched.toLocaleString() +
        " matched from your list";
    } else {
      countEl.textContent =
        tracked.toLocaleString() +
        " in catalog · " +
        s.num_parts.toLocaleString() +
        " LEGO count · " +
        matched.toLocaleString() +
        " matched";
    }

    // % sort path attaches pct early; other sorts compute lazily here
    var pct =
      typeof s.pct === "number" && !isNaN(s.pct)
        ? s.pct
        : C.getCompletionPct(s, ownedPartIds);
    var fill = card.querySelector(".progress-fill");
    fill.style.width = pct + "%";
    card.querySelector(".progress-text").textContent = pct + "% match (your parts)";

    var progressWrap = card.querySelector(".progress-wrap");
    progressWrap.setAttribute("aria-label", "Catalog match " + pct + " percent");

    var badges = card.querySelector(".card-badges");
    badges.innerHTML = "";
    var wl = getWishlistEntry(s.id);
    if (wl && wl.owned) {
      var b1 = document.createElement("span");
      b1.className = "badge badge-owned";
      b1.textContent = "Set owned";
      badges.appendChild(b1);
    } else if (wl) {
      var b2 = document.createElement("span");
      b2.className = "badge";
      b2.textContent = "Wishlist";
      badges.appendChild(b2);
    }

    var wishBtn = card.querySelector(".btn-wishlist");
    wishBtn.textContent = wl ? "Remove from wishlist" : "+ Wishlist";
  }

  function makeCard(template, s) {
    var card = template.cloneNode(true);
    card.classList.remove("card-template");
    card.style.display = "block";
    card.dataset.setId = s.id;
    card.removeAttribute("aria-hidden");
    fillCard(card, s);
    return card;
  }

  function paintVirtual(force) {
    var data = catalogVirtualRows;
    var vp = document.getElementById("catalog-scroll-viewport");
    var track = document.getElementById("catalog-virtual-track");
    var cardContainer = document.getElementById("card-container");
    var template = document.querySelector(".card-template");
    if (!data || !data.length || !vp || !track || !cardContainer || !template) return;

    track.style.width = "100%";
    vp.style.width = "100%";

    // min of a few widths — sometimes the track was wider than the scroll clip and cards vanished
    var rectW = typeof vp.getBoundingClientRect === "function" ? vp.getBoundingClientRect().width : 0;
    var cand = [];
    var vpW = vp.clientWidth;
    if (vpW > 40) cand.push(vpW);
    var trW = track.clientWidth;
    if (trW > 40) cand.push(trW);
    if (rectW > 40) cand.push(rectW);
    if (cand.length === 0) {
      var mainCol = document.querySelector(".main-column");
      var mcW = mainCol ? mainCol.clientWidth : 0;
      if (mcW > 40) cand.push(mcW);
    }
    var tw = cand.length ? Math.min.apply(null, cand) : 800;
    if (!isFinite(tw) || tw < 48) {
      tw = typeof window.innerWidth === "number" ? Math.max(0, window.innerWidth - 32) : 800;
    }
    var gap = CATALOG_GRID_GAP_PX;
    var cols = Math.max(1, Math.floor((tw + gap) / (CATALOG_MIN_CARD_PX + gap)));
    var usable = tw - (cols - 1) * gap;
    var cardW = Math.floor(usable / cols);
    if (!isFinite(cardW) || cardW < 60) {
      cardW = Math.min(CATALOG_MIN_CARD_PX, Math.floor(tw));
    }
    var rows = Math.ceil(data.length / cols);

    var slotPx = CATALOG_ROW_SLOT_PX;
    var rowStride = slotPx + gap;
    var totalH = rows === 0 ? 0 : (rows - 1) * rowStride + slotPx;
    track.style.minHeight = totalH + "px";

    var st = vp.scrollTop;
    var vh = vp.clientHeight || 600;
    var firstRow = Math.floor(st / rowStride);
    if (firstRow < 0) firstRow = 0;
    var lastRow = Math.ceil((st + vh) / rowStride);
    var buf = 1;
    firstRow = Math.max(0, firstRow - buf);
    lastRow = Math.min(rows - 1, lastRow + buf);

    var i0 = firstRow * cols;
    var i1 = Math.min(data.length, (lastRow + 1) * cols);
    if (i1 <= i0) {
      i0 = 0;
      i1 = Math.min(data.length, Math.max(cols * 2, 1));
    }

    // if this string matches last paint, dom is already right (scroll coarsened on purpose)
    var skipKey =
      String(i0) +
      "|" +
      String(i1) +
      "|" +
      String(cols) +
      "|" +
      String(Math.round(tw)) +
      "|" +
      String(Math.round(cardW * 10) / 10) +
      "|" +
      String(Math.floor(st / 8)) +
      "|" +
      String(wishlistBySetId.size) +
      "|" +
      String(catalogOwnedEpoch);
    if (!force && skipKey === lastVirtualPaintKey) return;
    lastVirtualPaintKey = skipKey;

    var pool = {};
    var prevCards = Array.prototype.slice.call(cardContainer.querySelectorAll("[data-set-id]"));
    for (var pc = 0; pc < prevCards.length; pc++) {
      var ex = prevCards[pc];
      pool[ex.dataset.setId] = ex;
      cardContainer.removeChild(ex);
    }

    cardContainer.style.display = "block";
    cardContainer.style.position = "relative";
    cardContainer.style.minHeight = totalH + "px";
    cardContainer.style.width = "100%";

    for (var i = i0; i < i1; i++) {
      var s = data[i];
      var row = Math.floor(i / cols);
      var col = i % cols;
      var card = pool[s.id];
      if (card) {
        delete pool[s.id];
        fillCard(card, s);
      } else {
        card = makeCard(template, s);
      }
      card.style.position = "absolute";
      card.style.boxSizing = "border-box";
      card.style.width = cardW + "px";
      card.style.height = slotPx + "px";
      card.style.maxHeight = slotPx + "px";
      card.style.left = col * (cardW + gap) + "px";
      card.style.top = row * rowStride + "px";
      cardContainer.appendChild(card);
    }

    for (var rest in pool) {
      if (Object.prototype.hasOwnProperty.call(pool, rest)) {
        delete pool[rest];
      }
    }

    setBrowseLine(true, data.length, i0 + 1, i1);
  }
  function updateCollectionMetric() {
    var el = document.getElementById("collection-metric");
    if (!el) return;
    var n = ownedPartIds.size;
    if (n === 0) {
      el.textContent = "0 parts — every card stays at 0%.";
    } else {
      el.textContent = n + " part" + (n === 1 ? "" : "s") + " — used for % on each card.";
    }
  }

  function updateWishlistToggleCount() {
    var btn = document.getElementById("wishlist-toggle");
    if (!btn) return;
    var badge = btn.querySelector(".wishlist-count");
    if (!badge) return;
    var n = wishlistBySetId.size;
    badge.textContent = String(n);
    badge.style.display = n > 0 ? "inline-flex" : "none";
  }

  var OWNED_CHIPS_PREVIEW_MAX = 2;

  function syncChipsToggleVisibility() {
    var btn = document.getElementById("owned-chips-toggle");
    var shell = document.getElementById("owned-chips-shell");
    if (!btn || !shell) return;
    if (ownedPartIds.size === 0) {
      btn.classList.add("hidden");
      shell.classList.remove("owned-chips-shell--collapsed");
      ownedChipsExpanded = false;
    } else if (ownedPartIds.size <= OWNED_CHIPS_PREVIEW_MAX) {
      btn.classList.add("hidden");
      ownedChipsExpanded = false;
    } else {
      btn.classList.remove("hidden");
    }
  }

  function syncOwnedChipsCollapsed() {
    var shell = document.getElementById("owned-chips-shell");
    if (!shell || ownedPartIds.size === 0) return;
    if (ownedChipsExpanded || ownedPartIds.size <= OWNED_CHIPS_PREVIEW_MAX) {
      shell.classList.remove("owned-chips-shell--collapsed");
    } else {
      shell.classList.add("owned-chips-shell--collapsed");
    }
  }
  function updateOwnedChipsToggleLabel() {
    var btn = document.getElementById("owned-chips-toggle");
    if (!btn || ownedPartIds.size === 0) return;
    btn.textContent = ownedChipsExpanded ? "Show less" : "Show all";
    btn.setAttribute("aria-expanded", String(ownedChipsExpanded));
  }

  function closeWishlistDrawer() {
    if (!wishlistOpen) return;
    wishlistOpen = false;
    var bd = document.getElementById("wishlist-backdrop");
    var dr = document.getElementById("wishlist-drawer");
    var tg = document.getElementById("wishlist-toggle");
    if (bd) {
      bd.classList.add("hidden");
      bd.setAttribute("aria-hidden", "true");
    }
    if (dr) {
      dr.classList.add("hidden");
    }
    if (tg) {
      tg.setAttribute("aria-expanded", "false");
    }
  }
  function openWishlistDrawer() {
    wishlistOpen = true;
    var bd = document.getElementById("wishlist-backdrop");
    var dr = document.getElementById("wishlist-drawer");
    var tg = document.getElementById("wishlist-toggle");
    if (bd) {
      bd.classList.remove("hidden");
      bd.setAttribute("aria-hidden", "false");
    }
    if (dr) {
      dr.classList.remove("hidden");
    }
    if (tg) {
      tg.setAttribute("aria-expanded", "true");
    }
  }

  function render() {
    var sortBy = document.getElementById("sort-select").value;
    var filters = getFilters();
    var all = catalogSets();
    var filtered = C.filterSets(all, filters);
    // % sort needs every row's pct first; name/year/etc. can defer pct to makeCard
    var catalogOrdered =
      sortBy === "pct"
        ? C.sortSetsWithPct(C.withCompletionPct(filtered, ownedPartIds), sortBy)
        : C.sortSetsWithPct(filtered, sortBy);

    var fk = filterKey();
    var filterChanged =
      fk !== lastCatalogFilterKey || catalogOrdered.length !== lastCatalogMatchCount;
    if (filterChanged) {
      // new query — don't leave the user scrolled into empty spacer
      var vpReset = document.getElementById("catalog-scroll-viewport");
      if (vpReset) vpReset.scrollTop = 0;
      lastVirtualPaintKey = "";
    }
    lastCatalogFilterKey = fk;
    lastCatalogMatchCount = catalogOrdered.length;

    setStatLine(catalogOrdered.length, all.length);

    var emptyEl = document.getElementById("empty-state");
    var cardContainer = document.getElementById("card-container");
    var catalogVp = document.getElementById("catalog-scroll-viewport");
    var catalogTrack = document.getElementById("catalog-virtual-track");
    var template = document.querySelector(".card-template");
    if (catalogOrdered.length === 0) {
      emptyEl.classList.remove("hidden");
      catalogVirtualRows = null;
      if (cardContainer) cardContainer.innerHTML = "";
      if (catalogVp) {
        catalogVp.classList.remove("catalog-scroll-viewport--virtual");
        catalogVp.scrollTop = 0;
      }
      if (catalogTrack) catalogTrack.style.minHeight = "";
      if (cardContainer) {
        cardContainer.style.cssText = "";
        cardContainer.className = "card-grid";
      }
      hideBrowseLine();
      renderWishlist();
      renderOwnedChips();
      updateCollectionMetric();
      queueBackTop();
      return;
    }

    emptyEl.classList.add("hidden");

    var useVirtual = catalogOrdered.length > CATALOG_VIRTUAL_THRESHOLD;
    if (useVirtual) {
      catalogVirtualRows = catalogOrdered;
      if (catalogVp) catalogVp.classList.add("catalog-scroll-viewport--virtual");
      if (cardContainer) {
        cardContainer.className = "card-grid";
        cardContainer.style.cssText = "";
      }
      paintVirtual(true);
      requestAnimationFrame(function () {
        if (catalogVirtualRows) queueResize();
      });
    } else {
      catalogVirtualRows = null;
      lastVirtualPaintKey = "";
      if (catalogVp) {
        catalogVp.classList.remove("catalog-scroll-viewport--virtual");
        catalogVp.scrollTop = 0;
      }
      if (catalogTrack) catalogTrack.style.minHeight = "";
      if (cardContainer) {
        cardContainer.innerHTML = "";
        cardContainer.style.cssText = "";
        cardContainer.className = "card-grid";
      }
      for (var ci = 0; ci < catalogOrdered.length; ci++) {
        cardContainer.appendChild(makeCard(template, catalogOrdered[ci]));
      }
      setBrowseLine(false, catalogOrdered.length, 1, catalogOrdered.length);
    }

    renderWishlist();
    renderOwnedChips();
    updateCollectionMetric();
    queueBackTop();
  }
  function renderWishlist() {
    var ul = document.getElementById("wishlist-list");
    if (!ul) return;
    ul.innerHTML = "";
    if (wishlistBySetId.size === 0) {
      var li0 = document.createElement("li");
      li0.className = "wishlist-item wishlist-empty";
      li0.textContent =
        "No sets saved yet — use “+ Wishlist” on a card or “Add to wishlist” in set details.";
      ul.appendChild(li0);
      updateWishlistToggleCount();
      return;
    }
    var wishEntries = Array.from(wishlistBySetId.values());
    for (var j = 0; j < wishEntries.length; j++) {
      var entry = wishEntries[j];
      var set = findSetById(entry.setId);
      var li = document.createElement("li");
      li.className = "wishlist-item";
      var title = document.createElement("div");
      title.className = "wishlist-item-title";
      title.textContent = set ? set.name : entry.setId;
      li.appendChild(title);

      var row = document.createElement("div");
      row.className = "wishlist-actions";

      var ownBtn = document.createElement("button");
      ownBtn.type = "button";
      ownBtn.className = "button button-small";
      ownBtn.textContent = entry.owned ? "Unmark owned" : "Mark owned";
      ownBtn.addEventListener(
        "click",
        (function (sid, nextOwned) {
          return function () {
            setWishlistOwned(sid, nextOwned);
            render();
          };
        })(entry.setId, !entry.owned),
      );
      var rm = document.createElement("button");
      rm.type = "button";
      rm.className = "button button-small button-secondary";
      rm.textContent = "Remove";
      rm.addEventListener(
        "click",
        (function (sid) {
          return function () {
            wishlistBySetId.delete(sid);
            render();
          };
        })(entry.setId),
      );

      row.appendChild(ownBtn);
      row.appendChild(rm);
      li.appendChild(row);
      ul.appendChild(li);
    }
    updateWishlistToggleCount();
  }
  function renderOwnedChips() {
    var wrap = document.getElementById("owned-chips");
    if (!wrap) return;
    wrap.innerHTML = "";
    if (ownedPartIds.size === 0) {
      syncChipsToggleVisibility();
      syncOwnedChipsCollapsed();
      updateOwnedChipsToggleLabel();
      return;
    }
    ownedPartIds.forEach(function (id) {
      var meta = findPartMeta(id);
      var label = meta ? meta.name + " (" + id + ")" : id;
      var chip = document.createElement("span");
      chip.className = "chip";
      chip.innerHTML = "<span class=\"chip-text\">" + escapeHtml(label) + "</span>";
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "chip-remove";
      btn.setAttribute("aria-label", "Remove " + label);
      btn.textContent = "×";
      btn.addEventListener(
        "click",
        (function (pid) {
          return function () {
            ownedPartIds.delete(pid);
            catalogOwnedEpoch += 1;
            render();
            drawPartHits();
          };
        })(id),
      );
      chip.appendChild(btn);
      wrap.appendChild(chip);
    });
    syncChipsToggleVisibility();
    syncOwnedChipsCollapsed();
    updateOwnedChipsToggleLabel();
  }

  function escapeHtml(s) {
    // chips use innerHTML; part names aren't html
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function addPartHit(box, part) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "part-suggestion";
    btn.setAttribute("role", "option");
    btn.innerHTML =
      "<span class=\"part-suggestion-name\">" +
      escapeHtml(part.name) +
      "</span><small class=\"part-suggestion-meta\">" +
      escapeHtml(part.category) +
      " · " +
      escapeHtml(part.id) +
      "</small>";
    btn.addEventListener(
      "click",
      (function (pid) {
        return function () {
          ownedPartIds.add(pid);
          catalogOwnedEpoch += 1;
          render();
          drawPartHits();
        };
      })(part.id),
    );
    box.appendChild(btn);
  }

  function drawPartHits() {
    var box = document.getElementById("part-suggestions");
    var q = document.getElementById("part-search").value;
    box.innerHTML = "";
    if (!q.trim()) {
      return;
    }
    var res = C.matchParts(parts, q, 150);
    var matches = res.list;
    if (matches.length === 0) {
      var p1 = document.createElement("p");
      p1.className = "suggestions-placeholder";
      p1.textContent = "No matches — try another word.";
      box.appendChild(p1);
      return;
    }
    for (var m = 0; m < matches.length; m++) {
      addPartHit(box, matches[m]);
    }
    if (res.truncated) {
      var more = document.createElement("p");
      more.className = "suggestions-placeholder";
      more.textContent =
        "More parts match this search — narrow it, or paste the full part ID (exact ID is always found).";
      box.appendChild(more);
    }
  }

  function fillThemes() {
    var sel = document.getElementById("theme-select");
    var current = sel.value;
    var seen = {};
    var themeList = [];
    var cs = catalogSets();
    for (var t = 0; t < cs.length; t++) {
      var th = cs[t].theme;
      if (!seen[th]) {
        seen[th] = true;
        themeList.push(th);
      }
    }
    themeList.sort(function (a, b) {
      return a.localeCompare(b);
    });
    sel.innerHTML = "";
    var all = document.createElement("option");
    all.value = "";
    all.textContent = "All themes";
    all.title = "All themes";
    sel.appendChild(all);
    for (var u = 0; u < themeList.length; u++) {
      var o = document.createElement("option");
      o.value = themeList[u];
      o.textContent = themeList[u];
      o.title = themeList[u];
      sel.appendChild(o);
    }
    var found = false;
    for (var v = 0; v < sel.options.length; v++) {
      if (sel.options[v].value === current) {
        found = true;
        break;
      }
    }
    // keep selection if that theme still exists after we rebuilt the list
    if (found) sel.value = current;
  }
  function fillPartSelect() {
    var sel = document.querySelector("#custom-set-form select[name='part_ids']");
    if (!sel) return;
    sel.innerHTML = "";
    for (var w = 0; w < parts.length; w++) {
      var p = parts[w];
      var o = document.createElement("option");
      o.value = p.id;
      o.textContent = p.name + " (" + p.id + ")";
      sel.appendChild(o);
    }
  }

  function syncDetailWishlistBtn() {
    var btn = document.getElementById("detail-wishlist-btn");
    if (!btn) return;
    if (!detailModalSetId) {
      btn.setAttribute("hidden", "hidden");
      return;
    }
    btn.removeAttribute("hidden");
    var wl = getWishlistEntry(detailModalSetId);
    btn.textContent = wl ? "Remove from wishlist" : "Add to wishlist";
  }

  function openDetail(setId) {
    var set = findSetById(setId);
    if (!set) return;
    var missing = C.missingPartIds(set, ownedPartIds);
    var titleEl = document.getElementById("detail-modal-title");
    var summary = document.getElementById("detail-summary");
    var list = document.getElementById("detail-missing-list");
    var missHead = document.getElementById("detail-missing-heading");
    if (!titleEl || !summary || !list) return;

    detailModalSetId = setId;
    titleEl.textContent = set.name;
    var pct = C.getCompletionPct(set, ownedPartIds);
    var tracked = set.parts ? set.parts.length : 0;
    var matched = C.ownedPartsCountInSet(set, ownedPartIds);

    var dImg = document.getElementById("detail-set-img");
    if (dImg) {
      dImg.alt = set.name + " box art";
      bindSetImage(dImg, set);
    }

    var dl = document.getElementById("detail-stats");
    if (dl) {
      dl.innerHTML = "";
      function addStat(label, value) {
        var dt = document.createElement("dt");
        dt.textContent = label;
        var dd = document.createElement("dd");
        dd.textContent = value;
        dl.appendChild(dt);
        dl.appendChild(dd);
      }
      addStat("Set number", String(set.id));
      addStat("Theme", set.theme);
      addStat("Year", String(set.year));
      addStat("LEGO piece count", set.num_parts.toLocaleString());
      addStat("Parts in this catalog", tracked.toLocaleString());
      addStat("Your list matched", matched.toLocaleString());
      addStat("Catalog match", pct + "%");
    }

    summary.textContent =
      "Match % compares your “Parts I have” list only to the subset of catalog parts included for this set in Buildable — it can differ from LEGO’s official piece count.";

    if (missHead) {
      missHead.textContent =
        missing.length === 0
          ? "Parts you still need"
          : "Parts you still need (" + missing.length.toLocaleString() + ")";
    }

    list.innerHTML = "";
    if (missing.length === 0) {
      var li0 = document.createElement("li");
      li0.textContent = "You already listed every tracked catalog part this set needs.";
      list.appendChild(li0);
    } else {
      for (var x = 0; x < missing.length; x++) {
        var pid = missing[x];
        var meta = findPartMeta(pid);
        var li = document.createElement("li");
        if (meta) {
          li.textContent = meta.name + " — " + meta.category + " (" + pid + ")";
        } else {
          li.textContent = pid + " (not in parts catalog — data drift)";
        }
        list.appendChild(li);
      }
    }
    closeWishlistDrawer();
    syncDetailWishlistBtn();
    document.getElementById("detail-backdrop").classList.remove("hidden");
    document.getElementById("detail-modal").classList.remove("hidden");
  }

  function closeDetail() {
    detailModalSetId = null;
    document.getElementById("detail-backdrop").classList.add("hidden");
    document.getElementById("detail-modal").classList.add("hidden");
  }

  function syncBackTop() {
    var btn = document.getElementById("back-to-top");
    if (!btn) return;
    var vp = document.getElementById("catalog-scroll-viewport");
    // inner = catalog viewport; outer = whole page (sticky filters / short viewports)
    var inner = vp && vp.scrollTop > 48;
    var outer = window.scrollY > 120;
    var show = inner || outer;
    if (show) {
      btn.classList.add("back-to-top--visible");
      btn.removeAttribute("tabindex");
    } else {
      btn.classList.remove("back-to-top--visible");
      btn.setAttribute("tabindex", "-1");
    }
  }

  function queueBackTop() {
    if (backToTopRaf) return;
    backToTopRaf = requestAnimationFrame(function () {
      backToTopRaf = 0;
      syncBackTop();
    });
  }

  function queueResize() {
    if (layoutResizeTimer !== null) clearTimeout(layoutResizeTimer);
    layoutResizeTimer = setTimeout(function () {
      layoutResizeTimer = null;
      if (catalogScrollRaf) {
        cancelAnimationFrame(catalogScrollRaf);
        catalogScrollRaf = 0;
      }
      requestAnimationFrame(function () {
        // double raf: first layout pass after resize, then measure/paint virtual grid
        requestAnimationFrame(function () {
          if (catalogVirtualRows) {
            lastVirtualPaintKey = "";
            paintVirtual(true);
          }
          queueBackTop();
        });
      });
    }, 0);
  }

  function scrollBothToTop() {
    var vp = document.getElementById("catalog-scroll-viewport");
    try {
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e) {
      window.scrollTo(0, 0);
    }
    if (vp) {
      try {
        vp.scrollTo({ top: 0, behavior: "smooth" });
      } catch (e2) {
        vp.scrollTop = 0;
      }
      lastVirtualPaintKey = "";
      if (catalogVirtualRows) paintVirtual(true);
    }
    queueBackTop();
  }

  function bindCardClicks() {
    document.getElementById("card-container").addEventListener("click", function (e) {
      var target = e.target;
      var card = target.closest && target.closest(".card");
      if (!card || !card.dataset.setId) return;
      var setId = card.dataset.setId;
      if (target.closest && target.closest(".btn-wishlist")) {
        // button is inside the card — don't bubble to openDetail
        e.preventDefault();
        toggleWishlist(setId);
        render();
        if (detailModalSetId === setId) syncDetailWishlistBtn();
        return;
      }
      openDetail(setId);
    });
  }
  var THEME_STORAGE_KEY = "buildable-theme";

  function getAppliedTheme() {
    // light = no attribute — matches the tiny inline boot script in index.html
    return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
  }

  function syncTheme() {
    var dark = getAppliedTheme() === "dark";
    var btn = document.getElementById("theme-toggle");
    if (btn) {
      var moon = btn.querySelector(".theme-toggle-icon--moon");
      var sun = btn.querySelector(".theme-toggle-icon--sun");
      if (moon && sun) {
        moon.classList.toggle("hidden", dark);
        sun.classList.toggle("hidden", !dark);
      }
      btn.setAttribute("aria-label", dark ? "Switch to light theme" : "Switch to dark theme");
      btn.setAttribute("title", dark ? "Light mode (Barbie pink)" : "Dark mode");
    }
  }

  function setTheme(next) {
    if (next === "dark") document.documentElement.setAttribute("data-theme", "dark");
    else document.documentElement.removeAttribute("data-theme");
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next === "dark" ? "dark" : "light");
    } catch (e) {}
    syncTheme();
  }

  function initThemeToggle() {
    syncTheme();
    var btn = document.getElementById("theme-toggle");
    if (!btn) return;
    btn.addEventListener("click", function () {
      setTheme(getAppliedTheme() === "dark" ? "light" : "dark");
    });
  }

  function init() {
    initThemeToggle();
    rebuildPartIndex();
    rebuildSetIndex();
    fillThemes();
    fillPartSelect();

    document.getElementById("theme-select").addEventListener("change", render);
    document.getElementById("era-select").addEventListener("change", render);
    document.getElementById("sort-select").addEventListener("change", render);
    document.getElementById("set-search").addEventListener("input", render);

    var catalogVp = document.getElementById("catalog-scroll-viewport");
    if (catalogVp) {
      catalogVp.addEventListener(
        "scroll",
        function () {
          queueVirtualPaint();
          queueBackTop();
        },
        { passive: true },
      );
      if (typeof ResizeObserver !== "undefined") {
        new ResizeObserver(queueResize).observe(catalogVp);
      }
    }
    var mainColumn = document.querySelector(".main-column");
    if (mainColumn && typeof ResizeObserver !== "undefined") {
      new ResizeObserver(queueResize).observe(mainColumn);
    }
    var layoutRoot = document.querySelector(".layout");
    if (layoutRoot && typeof ResizeObserver !== "undefined") {
      new ResizeObserver(queueResize).observe(layoutRoot);
    }
    window.addEventListener("resize", queueResize, { passive: true });
    window.addEventListener("orientationchange", queueResize);
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", queueResize);
    }

    document.getElementById("part-search").addEventListener("input", function () {
      drawPartHits();
    });

    document.getElementById("detail-close").addEventListener("click", closeDetail);
    document.getElementById("detail-backdrop").addEventListener("click", closeDetail);
    var detailWishlistBtn = document.getElementById("detail-wishlist-btn");
    if (detailWishlistBtn) {
      detailWishlistBtn.addEventListener("click", function () {
        if (!detailModalSetId) return;
        toggleWishlist(detailModalSetId);
        render();
        syncDetailWishlistBtn();
      });
    }
    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape") return;
      var modal = document.getElementById("detail-modal");
      if (modal && !modal.classList.contains("hidden")) {
        closeDetail();
        return;
      }
      closeWishlistDrawer();
    });

    var wishlistToggle = document.getElementById("wishlist-toggle");
    if (wishlistToggle) {
      wishlistToggle.addEventListener("click", function () {
        if (wishlistOpen) closeWishlistDrawer();
        else openWishlistDrawer();
      });
    }
    var wishlistBackdrop = document.getElementById("wishlist-backdrop");
    if (wishlistBackdrop) {
      wishlistBackdrop.addEventListener("click", closeWishlistDrawer);
    }

    var chipsToggle = document.getElementById("owned-chips-toggle");
    if (chipsToggle) {
      chipsToggle.addEventListener("click", function () {
        ownedChipsExpanded = !ownedChipsExpanded;
        syncOwnedChipsCollapsed();
        updateOwnedChipsToggleLabel();
      });
    }

    document.getElementById("toggle-custom-set").addEventListener("click", function () {
      var p = document.getElementById("custom-set-panel");
      p.classList.toggle("hidden");
      var open = !p.classList.contains("hidden");
      document.getElementById("toggle-custom-set").setAttribute("aria-expanded", String(open));
    });
    document.getElementById("cancel-custom-set").addEventListener("click", function () {
      document.getElementById("custom-set-panel").classList.add("hidden");
      document.getElementById("toggle-custom-set").setAttribute("aria-expanded", "false");
    });

    document.getElementById("custom-set-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var form = e.target;
      var name = form.name.value.trim();
      var year = parseInt(form.year.value, 10);
      var theme = form.theme.value.trim();
      var sel = form.part_ids;
      var selected = [];
      for (var i = 0; i < sel.options.length; i++) {
        if (sel.options[i].selected) selected.push(sel.options[i].value);
      }
      if (!name || !theme || !isFinite(year)) return;
      var newSet = {
        id: "custom-" + Date.now(),
        name: name,
        year: year,
        theme: theme,
        num_parts: selected.length,
        image: PLACEHOLDER_IMG,
        parts: selected,
      };
      userSets.push(newSet);
      rebuildSetIndex();
      form.reset();
      document.getElementById("custom-set-panel").classList.add("hidden");
      document.getElementById("toggle-custom-set").setAttribute("aria-expanded", "false");
      fillThemes();
      fillPartSelect();
      render();
    });

    bindCardClicks();

    var backToTopBtn = document.getElementById("back-to-top");
    if (backToTopBtn) {
      backToTopBtn.addEventListener("click", scrollBothToTop);
    }
    window.addEventListener("scroll", queueBackTop, { passive: true });

    render();
    drawPartHits();
    queueBackTop();
    queueResize();
  }

  global.BuildableUI = { init: init };
})(typeof window !== "undefined" ? window : this);

(function () {
  "use strict";
  document.addEventListener("DOMContentLoaded", function () {
    if (typeof parts === "undefined" || typeof sets === "undefined") {
      document.body.innerHTML =
        "<p style='padding:2rem;font-family:system-ui,sans-serif;max-width:40rem;line-height:1.5'>Missing <code>data.js</code> — run <code>python3 scripts/build_data.py</code> from the project root, then refresh.</p>";
      return;
    }
    if (typeof window.BuildableUI === "undefined") {
      document.body.innerHTML =
        "<p style='padding:2rem;font-family:system-ui,sans-serif'>Missing BuildableUI — ensure <code>scripts.js</code> loaded without errors.</p>";
      return;
    }
    window.BuildableUI.init();
  });
})();
