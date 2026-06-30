/* ================================================================
   RIMA — script.js
   - Récupération dynamique des infos via Google Sheets (onglet "Infos")
   - Parsing robuste de la réponse gviz, avec diagnostic clair en console
   - Rendu de la carte complète (menu) par catégories + filtres
   - Boutons "Commander en ligne" modulaires (Deliveroo / UberEats)
   - Bandeau d'alerte conditionnel
   - Interactions UI (header, nav mobile plein écran, reveal, statut horaires)
   ================================================================ */

(function () {
  'use strict';

  /* ID du Google Sheet (extrait de l'URL fournie) */
  var SHEET_ID = '10g4tuhxuiV3IHFK8KYHrstUJnl9W32TwlhqWpGO7Ldc';

  /* Noms d'onglets TOLÉRÉS, par ordre de préférence. Le code essaie
     chaque nom jusqu'à en trouver un qui répond, ce qui rend le site
     robuste à un onglet renommé (ex. "Infos" → "General", "Liens" →
     "Lien"). Pour ajouter une variante, il suffit de l'ajouter à la
     liste correspondante. La casse exacte est requise par l'API Google,
     donc on liste les casses probables. */
  var SHEET_NAMES_INFOS = ['Infos', 'General', 'Général', 'Informations', 'Info'];
  var SHEET_NAMES_MENU = ['Menu', 'Carte', 'Menu '];
  var SHEET_NAMES_LINKS = ['Liens', 'Lien', 'Links', 'Commander'];
  var SHEET_NAMES_AVIS = ['Avis', 'Témoignages', 'Temoignages', 'Reviews'];
  var SHEET_NAMES_CONTACT = ['Contact', 'Réseaux', 'Reseaux', 'Social'];

  /* Libellés courts pour l'affichage du diagnostic (premier nom de chaque
     liste, considéré comme le nom canonique recommandé). */
  var LABEL_INFOS = SHEET_NAMES_INFOS[0];
  var LABEL_MENU = SHEET_NAMES_MENU[0];
  var LABEL_LINKS = SHEET_NAMES_LINKS[0];
  var LABEL_AVIS = SHEET_NAMES_AVIS[0];
  var LABEL_CONTACT = SHEET_NAMES_CONTACT[0];

  function buildSheetUrl(sheetName) {
    return 'https://docs.google.com/spreadsheets/d/' + SHEET_ID +
      '/gviz/tq?tqx=out:json&sheet=' + encodeURIComponent(sheetName) +
      '&cb=' + Date.now();
  }

  /**
   * Essaie successivement plusieurs noms d'onglets jusqu'à obtenir une
   * réponse gviz exploitable (statut OK avec une table). Renvoie une
   * promesse résolue avec { data, sheetName } au premier succès, ou
   * rejetée si aucun nom ne fonctionne.
   *
   * Google renvoie un statut "error" (pas une erreur HTTP) quand un
   * onglet n'existe pas — on détecte ce cas pour passer au nom suivant.
   */
  function fetchSheetWithFallback(candidateNames) {
    var names = candidateNames.slice();

    function tryNext() {
      if (!names.length) {
        return Promise.reject(new Error('Aucun des noms d\'onglets testés n\'a répondu : ' + candidateNames.join(', ')));
      }
      var name = names.shift();
      return fetch(buildSheetUrl(name))
        .then(function (res) {
          if (!res.ok) { throw new Error('HTTP ' + res.status); }
          return res.text();
        })
        .then(function (rawText) {
          var data = parseGvizResponse(rawText);
          if (data && data.table) {
            return { data: data, sheetName: name };
          }
          /* Onglet inexistant ou réponse non exploitable → nom suivant. */
          return tryNext();
        })
        .catch(function () {
          return tryNext();
        });
    }

    return tryNext();
  }

  var RESPONSE_REGEX = /google\.visualization\.Query\.setResponse\(([\s\S]*)\);/;

  /* État de synchronisation, alimenté par fetchSheetData(), fetchMenuData()
     et fetchLinksData(). Sert au widget de diagnostic (?debug=1) — c'est
     la seule source de vérité sur "le Sheet a-t-il réellement été lu
     avec succès, et quand pour la dernière fois ?". */
  var SYNC_STATUS = {
    infos: { state: 'pending', detail: '', lastSuccessAt: null },
    menu: { state: 'pending', detail: '', lastSuccessAt: null },
    liens: { state: 'pending', detail: '', lastSuccessAt: null },
    avis: { state: 'pending', detail: '', lastSuccessAt: null },
    contact: { state: 'pending', detail: '', lastSuccessAt: null }
  };

  /* Liens de commande/réservation (Deliveroo, UberEats, TheFork, etc.),
     alimentés par DEUX sources possibles, recombinées par
     refreshOrderLinks() :
     - LEGACY_ORDER_LINKS : anciennes clés "Lien Deliveroo"/"Lien UberEats"
       de l'onglet Infos (compatibilité avec les Sheets existants).
     - SHEET_ORDER_LINKS : nouvel onglet "Liens", générique et illimité.
     Si l'onglet "Liens" contient au moins une ligne valide, il prend le
     dessus sur les anciennes clés (évite les doublons). Sinon, repli sur
     les anciennes clés pour ne jamais casser un Sheet déjà en place. */
  var LEGACY_ORDER_LINKS = [];
  var SHEET_ORDER_LINKS = null;

  /* Réseaux sociaux (Instagram, TikTok…), alimentés par DEUX sources
     recombinées par refreshSocialLinks() :
     - LEGACY_SOCIAL : clés "Lien Instagram"/"Lien TikTok" trouvées dans
       l'onglet d'infos générales (compatibilité).
     - CONTACT_SOCIAL : mêmes clés trouvées dans l'onglet "Contact" dédié.
     L'onglet "Contact" prend le dessus s'il fournit une valeur. */
  var LEGACY_SOCIAL = {};
  var CONTACT_SOCIAL = {};

  document.addEventListener('DOMContentLoaded', function () {
    initHeaderScroll();
    initMobileNav();
    initRevealOnScroll();
    initOpeningStatus();
    initDiagnosticWidget();
    initCarteToggle();

    /* Affiche immédiatement la carte statique (MENU_DATA en dur) pour que
       la page ne soit jamais vide en attendant le réseau, puis la
       remplace par les données du Sheet si elles arrivent et sont
       valides. */
    renderMenu(MENU_DATA);

    fetchSheetData();
    fetchMenuData();
    fetchLinksData();
    fetchAvisData();
    fetchContactData();
  });

  /* ----------------------------------------------------------------
     0. Suivi de synchronisation + widget de diagnostic (?debug=1)
     ---------------------------------------------------------------- */

  function setSyncStatus(key, state, detail) {
    SYNC_STATUS[key].state = state;
    SYNC_STATUS[key].detail = detail || '';
    if (state === 'ok') { SYNC_STATUS[key].lastSuccessAt = new Date(); }
    renderDiagnosticWidget();
  }

  function isDebugMode() {
    try {
      return new URLSearchParams(window.location.search).get('debug') === '1';
    } catch (e) {
      return false;
    }
  }

  function initDiagnosticWidget() {
    if (!isDebugMode()) { return; }
    var widget = document.getElementById('sheet-diagnostic');
    if (!widget) { return; }
    widget.hidden = false;
    renderDiagnosticWidget();
  }

  function formatTime(date) {
    if (!date) { return 'jamais'; }
    return date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function renderDiagnosticWidget() {
    if (!isDebugMode()) { return; }
    var widget = document.getElementById('sheet-diagnostic');
    if (!widget || widget.hidden) { return; }

    function rowHtml(label, entry) {
      var dotClass = entry.state === 'ok' ? 'is-ok' : (entry.state === 'fail' ? 'is-fail' : 'is-pending');
      var stateLabel = entry.state === 'ok' ? 'OK' : (entry.state === 'fail' ? 'ÉCHEC' : 'En cours…');
      return (
        '<div class="sheet-diagnostic__row">' +
          '<span class="sheet-diagnostic__dot ' + dotClass + '" aria-hidden="true"></span>' +
          '<div>' +
            '<div><strong>' + escapeHtml(label) + '</strong> — ' + stateLabel + '</div>' +
            (entry.detail ? '<div class="sheet-diagnostic__detail">' + escapeHtml(entry.detail) + '</div>' : '') +
            '<div class="sheet-diagnostic__detail">Dernier succès : ' + formatTime(entry.lastSuccessAt) + '</div>' +
          '</div>' +
        '</div>'
      );
    }

    widget.innerHTML =
      '<div class="sheet-diagnostic__header">' +
        '<span>Diagnostic Google Sheet</span>' +
        '<button type="button" class="sheet-diagnostic__close" id="sheet-diagnostic-close" aria-label="Fermer">&times;</button>' +
      '</div>' +
      '<div class="sheet-diagnostic__body">' +
        rowHtml('Onglet « ' + LABEL_INFOS + ' »', SYNC_STATUS.infos) +
        rowHtml('Onglet « ' + LABEL_MENU + ' »', SYNC_STATUS.menu) +
        rowHtml('Onglet « ' + LABEL_LINKS + ' »', SYNC_STATUS.liens) +
        rowHtml('Onglet « ' + LABEL_AVIS + ' »', SYNC_STATUS.avis) +
        rowHtml('Onglet « ' + LABEL_CONTACT + ' »', SYNC_STATUS.contact) +
      '</div>' +
      '<div class="sheet-diagnostic__footer">Visible uniquement avec ?debug=1 dans l\'adresse. Les clients du site ne voient jamais ce panneau.</div>';

    var closeBtn = document.getElementById('sheet-diagnostic-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', function () { widget.hidden = true; });
    }
  }

  /* ----------------------------------------------------------------
     1. Récupération + parsing des données Google Sheets — onglet "Infos"
     ---------------------------------------------------------------- */

  function fetchSheetData() {
    fetchSheetWithFallback(SHEET_NAMES_INFOS)
      .then(function (result) {
        var infos = mapRowsToInfos(result.data);
        if (Object.keys(infos).length === 0) {
          var msg = 'L\'onglet "' + result.sheetName + '" a répondu mais aucune clé/valeur exploitable n\'a été trouvée.';
          console.warn('Rima — ' + msg);
          setSyncStatus('infos', 'fail', msg);
          return;
        }
        console.info('Rima — données du Sheet "' + result.sheetName + '" chargées :', infos);
        applyDynamicInfos(infos);
        setSyncStatus('infos', 'ok', Object.keys(infos).length + ' champs lus (onglet « ' + result.sheetName + ' »).');
      })
      .catch(function (err) {
        console.warn('Rima — impossible de charger les informations du Google Sheet :', err.message || err);
        console.warn('Rima — causes possibles : (1) le Sheet n\'est pas partagé publiquement, (2) aucun onglet ne porte un nom reconnu (' + SHEET_NAMES_INFOS.join(', ') + '), (3) l\'ID du Sheet a changé.');
        setSyncStatus('infos', 'fail', 'Aucun onglet reconnu (' + SHEET_NAMES_INFOS.join(', ') + ') ou Sheet non public.');
      });
  }

  /* ----------------------------------------------------------------
     1bis. Récupération + parsing — onglet "Menu" (la carte)
     ---------------------------------------------------------------- */

  function fetchMenuData() {
    fetchSheetWithFallback(SHEET_NAMES_MENU)
      .then(function (result) {
        var menuFromSheet = mapRowsToMenu(result.data);
        if (!menuFromSheet.length) {
          var msg = 'L\'onglet "' + result.sheetName + '" a répondu mais aucun plat exploitable n\'a été trouvé. Vérifiez les en-têtes (Catégorie, Plat, Prix...).';
          console.warn('Rima — ' + msg);
          setSyncStatus('menu', 'fail', msg);
          return;
        }
        var nbPlats = menuFromSheet.reduce(function (n, g) { return n + g.dishes.length; }, 0);
        console.info('Rima — menu chargé depuis le Sheet « ' + result.sheetName + ' » (' + nbPlats + ' plats, ' + menuFromSheet.length + ' catégories).');
        renderMenu(menuFromSheet);
        setSyncStatus('menu', 'ok', nbPlats + ' plats / ' + menuFromSheet.length + ' catégories (onglet « ' + result.sheetName + ' »).');
      })
      .catch(function (err) {
        /* Echec : la carte statique (MENU_DATA), déjà affichée au
           chargement de la page, reste en place (mieux vaut une carte
           légèrement périmée qu'une carte vide). Visible dans ?debug=1. */
        console.warn('Rima — impossible de charger la carte depuis le Sheet :', err.message || err);
        console.warn('Rima — carte en dur (MENU_DATA) conservée. Noms d\'onglets testés : ' + SHEET_NAMES_MENU.join(', ') + '.');
        setSyncStatus('menu', 'fail', 'Aucun onglet reconnu (' + SHEET_NAMES_MENU.join(', ') + ') — carte en dur conservée.');
      });
  }

  /**
   * Transforme les lignes de l'onglet "Menu" en la même structure que
   * MENU_DATA : un tableau de { category, dishes: [...] }.
   *
   * Colonnes attendues (en-têtes en ligne 1, peu importe l'ordre) :
   *   Catégorie | Plat | Unité | Prix | Description
   *
   * - "Catégorie", "Plat" et "Prix" sont obligatoires pour qu'une ligne
   *   soit prise en compte (une ligne incomplète est ignorée plutôt que
   *   de casser tout l'affichage).
   * - "Unité" et "Description" sont facultatives.
   * - L'ordre des catégories à l'écran suit l'ordre de leur première
   *   apparition dans le Sheet, donc on peut réordonner la carte en
   *   réordonnant les lignes.
   */
  function mapRowsToMenu(data) {
    var groups = [];
    var groupIndex = {};

    if (!data || !data.table || !data.table.cols || !data.table.rows) { return groups; }

    var cols = data.table.cols;
    var colIndexByName = {};
    cols.forEach(function (col, i) {
      var label = (col && col.label || '').trim().toLowerCase();
      if (label) { colIndexByName[label] = i; }
    });

    var idxCategory = colIndexByName['catégorie'] !== undefined ? colIndexByName['catégorie'] : colIndexByName['categorie'];
    var idxDish = colIndexByName['plat'];
    var idxUnit = colIndexByName['unité'] !== undefined ? colIndexByName['unité'] : colIndexByName['unite'];
    var idxPrice = colIndexByName['prix'];
    var idxDesc = colIndexByName['description'];

    if (idxCategory === undefined || idxDish === undefined || idxPrice === undefined) {
      console.warn('Rima — colonnes requises introuvables dans l\'onglet de menu (attendu au minimum : Catégorie, Plat, Prix).');
      return groups;
    }

    data.table.rows.forEach(function (row) {
      if (!row || !row.c) { return; }
      var category = cellValue(row.c[idxCategory]);
      var dishName = cellValue(row.c[idxDish]);
      var price = cellValue(row.c[idxPrice]);

      if (!category || !dishName || !price) { return; } /* ligne incomplète : ignorée */

      var unit = idxUnit !== undefined ? cellValue(row.c[idxUnit]) : '';
      var desc = idxDesc !== undefined ? cellValue(row.c[idxDesc]) : '';

      var dish = { name: dishName, price: price };
      if (unit) { dish.unit = unit; }
      if (desc) { dish.desc = desc; }

      if (!(category in groupIndex)) {
        groupIndex[category] = groups.length;
        groups.push({ category: category, dishes: [] });
      }
      groups[groupIndex[category]].dishes.push(dish);
    });

    return groups;
  }

  /* ----------------------------------------------------------------
     1ter. Récupération + parsing — onglet "Liens" (commande/réservation,
     générique et illimité : Deliveroo, UberEats, TheFork, et tout
     futur service sans jamais avoir à retoucher le code)
     ---------------------------------------------------------------- */

  function fetchLinksData() {
    fetchSheetWithFallback(SHEET_NAMES_LINKS)
      .then(function (result) {
        var linksFromSheet = mapRowsToLinks(result.data);
        if (!linksFromSheet.length) {
          setSyncStatus('liens', 'fail', 'Onglet « ' + result.sheetName + ' » trouvé mais vide ou colonnes introuvables (attendu : Plateforme, Lien). Repli sur les anciennes clés si présentes.');
          SHEET_ORDER_LINKS = null;
          refreshOrderLinks();
          return;
        }
        SHEET_ORDER_LINKS = linksFromSheet;
        setSyncStatus('liens', 'ok', linksFromSheet.length + ' lien(s) : ' + linksFromSheet.map(function (l) { return l.label; }).join(', ') + ' (onglet « ' + result.sheetName + ' »).');
        refreshOrderLinks();
      })
      .catch(function (err) {
        console.warn('Rima — aucun onglet de liens reconnu (' + SHEET_NAMES_LINKS.join(', ') + ') :', err.message || err);
        setSyncStatus('liens', 'fail', 'Aucun onglet reconnu (' + SHEET_NAMES_LINKS.join(', ') + '). Repli sur les anciennes clés Lien Deliveroo/UberEats si présentes.');
        SHEET_ORDER_LINKS = null;
        refreshOrderLinks();
      });
  }

  /**
   * Transforme les lignes de l'onglet "Liens" en tableau [{label, url}].
   * Colonnes attendues (en-têtes en ligne 1) : Plateforme | Lien.
   * Une ligne sans l'un des deux est ignorée. L'ordre d'affichage des
   * boutons suit l'ordre des lignes dans le Sheet.
   */
  /**
   * Transforme l'onglet "Liens" en tableau [{label, url}].
   *
   * Robuste à plusieurs structures, par ordre de préférence :
   *  1. Colonnes nommées (en-tête ligne 1) : on cherche une colonne de
   *     libellé (Plateforme, Nom, Service, Label...) et une colonne de
   *     lien (Lien, URL, Url, Adresse, Link...).
   *  2. À défaut d'en-têtes reconnus : détection automatique — la
   *     colonne dont les cellules contiennent des http(s) est l'URL,
   *     l'autre est le libellé. Ça marche quel que soit le nom des
   *     colonnes, voire sans en-tête du tout.
   *
   * Toute ligne sans libellé OU sans URL valide est ignorée.
   */
  function mapRowsToLinks(data) {
    var links = [];
    if (!data || !data.table || !data.table.cols || !data.table.rows) { return links; }

    var cols = data.table.cols;
    var rows = data.table.rows;

    var LABEL_NAMES = ['plateforme', 'nom', 'service', 'label', 'libellé', 'libelle', 'titre', 'name'];
    var URL_NAMES = ['lien', 'url', 'adresse', 'link', 'lienurl', 'liens'];

    var colIndexByName = {};
    cols.forEach(function (col, i) {
      var label = (col && col.label || '').trim().toLowerCase();
      if (label) { colIndexByName[label] = i; }
    });

    function findCol(names) {
      for (var k = 0; k < names.length; k++) {
        if (colIndexByName[names[k]] !== undefined) { return colIndexByName[names[k]]; }
      }
      return undefined;
    }

    var idxLabel = findCol(LABEL_NAMES);
    var idxUrl = findCol(URL_NAMES);

    /* Repli par détection automatique si les en-têtes ne sont pas
       reconnus : on inspecte les cellules pour trouver la colonne des
       URLs et celle des libellés. */
    if (idxLabel === undefined || idxUrl === undefined) {
      var detected = detectLinkColumns(rows, cols.length);
      if (detected) {
        idxUrl = detected.urlCol;
        idxLabel = detected.labelCol;
      }
    }

    if (idxUrl === undefined) { return links; }

    rows.forEach(function (row) {
      if (!row || !row.c) { return; }
      var url = cellValue(row.c[idxUrl]);
      if (!isValidUrl(url)) { return; }
      var label = (idxLabel !== undefined) ? cellValue(row.c[idxLabel]) : '';
      /* Si pas de libellé, on en dérive un lisible depuis le domaine. */
      if (!label) { label = labelFromUrl(url); }
      links.push({ label: label, url: url });
    });

    return links;
  }

  /* Inspecte les cellules pour repérer automatiquement la colonne
     contenant des URLs et une colonne de libellés. Renvoie
     { urlCol, labelCol } ou null. */
  function detectLinkColumns(rows, nbCols) {
    var urlHits = [];
    var i, j;
    for (j = 0; j < nbCols; j++) { urlHits[j] = 0; }

    rows.forEach(function (row) {
      if (!row || !row.c) { return; }
      for (j = 0; j < nbCols; j++) {
        if (isValidUrl(cellValue(row.c[j]))) { urlHits[j]++; }
      }
    });

    /* Colonne URL = celle avec le plus de cellules http(s). */
    var urlCol = -1, best = 0;
    for (j = 0; j < nbCols; j++) {
      if (urlHits[j] > best) { best = urlHits[j]; urlCol = j; }
    }
    if (urlCol === -1) { return null; }

    /* Colonne libellé = la première colonne non-URL ayant du texte. */
    var labelCol;
    for (j = 0; j < nbCols; j++) {
      if (j === urlCol) { continue; }
      var hasText = false;
      for (i = 0; i < rows.length; i++) {
        var v = rows[i] && rows[i].c ? cellValue(rows[i].c[j]) : '';
        if (v && !isValidUrl(v)) { hasText = true; break; }
      }
      if (hasText) { labelCol = j; break; }
    }

    return { urlCol: urlCol, labelCol: labelCol };
  }

  /* Dérive un libellé lisible depuis une URL (ex. deliveroo.fr →
     "Deliveroo"), utilisé seulement si aucun libellé n'est fourni. */
  function labelFromUrl(url) {
    try {
      var host = url.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0];
      var name = host.split('.')[0];
      return name.charAt(0).toUpperCase() + name.slice(1);
    } catch (e) {
      return 'Commander';
    }
  }

  /* ----------------------------------------------------------------
     1quater. Récupération + parsing — onglet "Avis" (témoignages)
     Colonnes attendues : Avis | Nom du client (ordre indifférent ;
     plusieurs noms de colonnes tolérés). Si l'onglet existe et contient
     au moins un avis valide, il remplace les 3 avis écrits en dur.
     ---------------------------------------------------------------- */

  function fetchAvisData() {
    fetchSheetWithFallback(SHEET_NAMES_AVIS)
      .then(function (result) {
        var avis = mapRowsToAvis(result.data);
        if (!avis.length) {
          setSyncStatus('avis', 'fail', 'Onglet « ' + result.sheetName + ' » trouvé mais aucun avis exploitable (attendu une colonne d\'avis et une colonne de nom).');
          return;
        }
        renderAvis(avis);
        setSyncStatus('avis', 'ok', avis.length + ' avis (onglet « ' + result.sheetName + ' »).');
      })
      .catch(function (err) {
        /* Echec : les 3 avis en dur dans le HTML restent affichés. */
        console.warn('Rima — aucun onglet d\'avis reconnu (' + SHEET_NAMES_AVIS.join(', ') + ') :', err.message || err);
        setSyncStatus('avis', 'fail', 'Aucun onglet reconnu (' + SHEET_NAMES_AVIS.join(', ') + ') — avis en dur conservés.');
      });
  }

  /**
   * Transforme l'onglet "Avis" en tableau [{text, author}].
   * Cherche une colonne d'avis (Avis, Témoignage, Commentaire, Texte...)
   * et une colonne de nom (Nom, Client, Auteur, "Nom du client"...).
   * À défaut d'en-têtes reconnus : la colonne au texte le plus long est
   * l'avis, l'autre est le nom. Une ligne sans texte d'avis est ignorée.
   */
  function mapRowsToAvis(data) {
    var avis = [];
    if (!data || !data.table || !data.table.cols || !data.table.rows) { return avis; }

    var cols = data.table.cols;
    var rows = data.table.rows;

    var TEXT_NAMES = ['avis', 'témoignage', 'temoignage', 'commentaire', 'texte', 'review', 'message'];
    var NAME_NAMES = ['nom', 'nom du client', 'nom du cliente', 'client', 'cliente', 'auteur', 'name', 'prénom', 'prenom'];

    var colIndexByName = {};
    cols.forEach(function (col, i) {
      var label = (col && col.label || '').trim().toLowerCase();
      if (label) { colIndexByName[label] = i; }
    });

    function findCol(names) {
      for (var k = 0; k < names.length; k++) {
        if (colIndexByName[names[k]] !== undefined) { return colIndexByName[names[k]]; }
      }
      return undefined;
    }

    var idxText = findCol(TEXT_NAMES);
    var idxName = findCol(NAME_NAMES);

    /* Repli : détection par longueur moyenne de texte (l'avis est plus
       long que le nom). */
    if (idxText === undefined) {
      var detected = detectAvisColumns(rows, cols.length);
      if (detected) {
        idxText = detected.textCol;
        if (idxName === undefined) { idxName = detected.nameCol; }
      }
    }

    if (idxText === undefined) { return avis; }

    rows.forEach(function (row) {
      if (!row || !row.c) { return; }
      var text = cellValue(row.c[idxText]);
      if (!text) { return; }
      var author = (idxName !== undefined) ? cellValue(row.c[idxName]) : '';
      avis.push({ text: text, author: author });
    });

    return avis;
  }

  /* Détecte, parmi les colonnes, celle des avis (texte le plus long en
     moyenne) et celle des noms (l'autre colonne textuelle). */
  function detectAvisColumns(rows, nbCols) {
    var totalLen = [], count = [];
    var j, i;
    for (j = 0; j < nbCols; j++) { totalLen[j] = 0; count[j] = 0; }

    rows.forEach(function (row) {
      if (!row || !row.c) { return; }
      for (j = 0; j < nbCols; j++) {
        var v = cellValue(row.c[j]);
        if (v) { totalLen[j] += v.length; count[j]++; }
      }
    });

    var textCol = -1, bestAvg = -1;
    for (j = 0; j < nbCols; j++) {
      var avg = count[j] ? totalLen[j] / count[j] : 0;
      if (avg > bestAvg) { bestAvg = avg; textCol = j; }
    }
    if (textCol === -1) { return null; }

    var nameCol;
    for (j = 0; j < nbCols; j++) {
      if (j === textCol) { continue; }
      if (count[j] > 0) { nameCol = j; break; }
    }

    return { textCol: textCol, nameCol: nameCol };
  }

  /* Remplace les avis affichés par ceux du Sheet. */
  function renderAvis(avis) {
    var grid = document.getElementById('avis-grid');
    if (!grid || !avis.length) { return; }

    grid.innerHTML = avis.map(function (a) {
      var quote = a.text.trim();
      /* Ajoute des guillemets français si l'auteur n'en a pas mis. */
      if (!/^[«"']/.test(quote)) { quote = '« ' + quote + ' »'; }
      var author = a.author ? a.author.trim() : 'Client';
      return (
        '<figure class="avis__card">' +
          '<blockquote>' + escapeHtml(quote) + '</blockquote>' +
          '<figcaption>— ' + escapeHtml(author) + '</figcaption>' +
        '</figure>'
      );
    }).join('');
  }

  /* ----------------------------------------------------------------
     1quinquies. Récupération + parsing — onglet "Contact" (réseaux
     sociaux). Format clé/valeur : "Lien Instagram" | <url>, etc.
     Prioritaire sur les éventuelles clés du même nom dans l'onglet
     général.
     ---------------------------------------------------------------- */

  function fetchContactData() {
    fetchSheetWithFallback(SHEET_NAMES_CONTACT)
      .then(function (result) {
        var infos = mapRowsToInfos(result.data);
        var instagram = infos['Lien Instagram'] || infos['Instagram'] || '';
        var tiktok = infos['Lien TikTok'] || infos['TikTok'] || infos['Lien Tiktok'] || infos['Tiktok'] || '';

        CONTACT_SOCIAL = { instagram: instagram, tiktok: tiktok };
        refreshSocialLinks();

        var found = [];
        if (isValidUrl(instagram)) { found.push('Instagram'); }
        if (isValidUrl(tiktok)) { found.push('TikTok'); }

        if (!found.length) {
          setSyncStatus('contact', 'fail', 'Onglet « ' + result.sheetName + ' » trouvé mais aucun lien social valide (attendu « Lien Instagram » / « Lien TikTok »).');
        } else {
          setSyncStatus('contact', 'ok', found.join(' + ') + ' (onglet « ' + result.sheetName + ' »).');
        }
      })
      .catch(function (err) {
        /* Echec : on garde les éventuels liens de l'onglet général. */
        console.warn('Rima — aucun onglet Contact reconnu (' + SHEET_NAMES_CONTACT.join(', ') + ') :', err.message || err);
        CONTACT_SOCIAL = {};
        refreshSocialLinks();
        setSyncStatus('contact', 'fail', 'Aucun onglet reconnu (' + SHEET_NAMES_CONTACT.join(', ') + ').');
      });
  }

  function parseGvizResponse(rawText) {
    if (/^\s*<(!DOCTYPE|html)/i.test(rawText)) {
      console.warn('Rima — la réponse du Sheet est une page HTML, pas du JSON. Le Sheet n\'est probablement pas partagé publiquement.');
      return null;
    }

    var match = RESPONSE_REGEX.exec(rawText);
    if (!match || !match[1]) {
      console.warn('Rima — format de réponse Google Sheets inattendu (regex non concluante).');
      return null;
    }
    try {
      return JSON.parse(match[1]);
    } catch (e) {
      console.warn('Rima — échec du parsing JSON de la réponse Sheets :', e);
      return null;
    }
  }

  function mapRowsToInfos(data) {
    var infos = {};
    if (!data || !data.table || !data.table.rows) { return infos; }

    var cols = data.table.cols || [];
    var rows = data.table.rows;
    var labeledCols = cols.filter(function (c) { return c && c.label && c.label.trim() !== ''; });

    var looksLikeKeyValue =
      cols.length <= 2 ||
      (labeledCols.length <= 1 && rows.length > 1);

    if (!looksLikeKeyValue && labeledCols.length > 1) {
      var firstRow = rows[0];
      if (firstRow) {
        cols.forEach(function (col, i) {
          var key = (col.label || '').trim();
          if (!key) { return; }
          infos[key] = cellValue(firstRow.c && firstRow.c[i]);
        });
      }
      return infos;
    }

    rows.forEach(function (row) {
      if (!row || !row.c) { return; }
      var key = cellValue(row.c[0]);
      var value = cellValue(row.c[1]);
      if (key) { infos[key.trim()] = value; }
    });

    return infos;
  }

  function cellValue(cell) {
    if (!cell) { return ''; }
    if (cell.f !== undefined && cell.f !== null) { return String(cell.f).trim(); }
    if (cell.v === undefined || cell.v === null) { return ''; }
    return String(cell.v).trim();
  }

  /* ----------------------------------------------------------------
     2. Application des données récupérées au DOM
     ---------------------------------------------------------------- */

  function applyDynamicInfos(infos) {
    applyAlertCard(infos['Message d\'alerte']);

    /* Compatibilité avec les Sheets existants : anciennes clés à deux
       liens fixes. Stockées à part, recombinées avec l'onglet "Liens"
       (générique, illimité) par refreshOrderLinks(). */
    var legacy = [];
    if (isValidUrl(infos['Lien Deliveroo'])) {
      legacy.push({ label: 'Deliveroo', url: infos['Lien Deliveroo'].trim() });
    }
    if (isValidUrl(infos['Lien UberEats'])) {
      legacy.push({ label: 'Uber Eats', url: infos['Lien UberEats'].trim() });
    }
    LEGACY_ORDER_LINKS = legacy;
    refreshOrderLinks();

    if (infos['Téléphone']) { applyPhoneNumber(infos['Téléphone']); }
    if (infos['Adresse complète']) { applyAddress(infos['Adresse complète']); }

    /* Réseaux sociaux : on mémorise les éventuelles clés présentes dans
       l'onglet général (compatibilité), puis on recombine avec l'onglet
       "Contact" dédié (prioritaire). */
    LEGACY_SOCIAL = {
      instagram: infos['Lien Instagram'] || '',
      tiktok: infos['Lien TikTok'] || ''
    };
    refreshSocialLinks();
  }

  /* Recombine les réseaux sociaux à partir des deux sources (onglet
     "Contact" prioritaire, puis repli sur les clés de l'onglet général)
     et l'applique au contact + footer. Appelée après chaque fetch
     concerné, dans n'importe quel ordre d'arrivée. */
  function refreshSocialLinks() {
    var instagram = CONTACT_SOCIAL.instagram || LEGACY_SOCIAL.instagram || '';
    var tiktok = CONTACT_SOCIAL.tiktok || LEGACY_SOCIAL.tiktok || '';
    applySocialLinks(instagram, tiktok);
  }

  /* Applique les liens Instagram/TikTok aux deux emplacements (bloc
     "Suivez-nous" du contact + icône du footer). Chaque lien est masqué
     individuellement s'il est absent ; la ligne sociale du contact se
     masque entièrement si aucun réseau n'est renseigné. */
  function applySocialLinks(instagram, tiktok) {
    var hasInsta = isValidUrl(instagram);
    var hasTiktok = isValidUrl(tiktok);

    /* --- Contact : bloc "Suivez-nous" --- */
    var row = document.getElementById('contact-social-row');
    var igContact = document.getElementById('contact-instagram');
    var ttContact = document.getElementById('contact-tiktok');

    if (igContact) {
      if (hasInsta) { igContact.setAttribute('href', instagram.trim()); igContact.hidden = false; }
      else { igContact.hidden = true; }
    }
    if (ttContact) {
      if (hasTiktok) { ttContact.setAttribute('href', tiktok.trim()); ttContact.hidden = false; }
      else { ttContact.hidden = true; }
    }
    if (row) { row.hidden = !(hasInsta || hasTiktok); }

    /* --- Footer : icône Instagram (conservée telle quelle) --- */
    var igFooter = document.getElementById('footer-instagram');
    if (igFooter) {
      if (hasInsta) { igFooter.setAttribute('href', instagram.trim()); igFooter.hidden = false; }
      else { igFooter.hidden = true; }
    }
    var ttFooter = document.getElementById('footer-tiktok');
    if (ttFooter) {
      if (hasTiktok) { ttFooter.setAttribute('href', tiktok.trim()); ttFooter.hidden = false; }
      else { ttFooter.hidden = true; }
    }
  }

  /* Le conteneur flottant en bas à droite (#float-order) héberge deux
     éléments indépendants : la carte d'alerte et le bouton "Commander".
     Chacun gère sa propre visibilité (hidden/non hidden) ; cette
     fonction se contente de révéler ou masquer le CONTENEUR selon que
     l'un des deux, au moins, a quelque chose à montrer — sinon rien ne
     flotte en bas à droite. */
  function syncFloatWidgetVisibility() {
    var floatWidget = document.getElementById('float-order');
    var alertCard = document.getElementById('alert-card');
    var orderToggle = document.getElementById('float-order-toggle');
    if (!floatWidget) { return; }

    var alertVisible = alertCard && !alertCard.hidden;
    var orderVisible = orderToggle && !orderToggle.hidden;

    floatWidget.hidden = !(alertVisible || orderVisible);
  }

  function applyAlertCard(message) {
    var card = document.getElementById('alert-card');
    var textEl = document.getElementById('alert-card-text');
    if (!card || !textEl) { return; }

    if (message && message.trim() !== '') {
      textEl.textContent = message.trim();
      card.hidden = false;

      var closeBtn = document.getElementById('alert-card-close');
      if (closeBtn && !closeBtn.dataset.bound) {
        closeBtn.dataset.bound = 'true';
        closeBtn.addEventListener('click', function () {
          card.hidden = true;
          syncFloatWidgetVisibility();
        });
      }
    } else {
      card.hidden = true;
    }

    syncFloatWidgetVisibility();
  }

  /* Recombine les deux sources possibles de liens de commande/réservation
     et déclenche le rendu. Appelée après CHAQUE fetch (Infos ou Liens),
     dans n'importe quel ordre d'arrivée, pour toujours refléter le
     dernier état connu des deux sources. */
  function refreshOrderLinks() {
    var links = (SHEET_ORDER_LINKS && SHEET_ORDER_LINKS.length) ? SHEET_ORDER_LINKS : LEGACY_ORDER_LINKS;
    applyOrderButtons(links);
  }

  function applyOrderButtons(links) {
    var validLinks = (links || []).filter(function (l) { return l && isValidUrl(l.url) && l.label; });

    var orderToggle = document.getElementById('float-order-toggle');
    var floatMenu = document.getElementById('float-order-menu');

    if (!validLinks.length) {
      if (orderToggle) { orderToggle.hidden = true; }
      syncFloatWidgetVisibility();
      return;
    }

    if (orderToggle && floatMenu) {
      orderToggle.hidden = false;
      /* Le menu déroulant (un bouton par lien) reste caché par défaut —
         il ne s'affiche QUE sur clic de l'icône "sac" ci-dessous, jamais
         en permanence. */
      floatMenu.innerHTML = validLinks.map(function (l) {
        return '<a class="float-order__link" href="' + escapeAttr(l.url.trim()) + '" target="_blank" rel="noopener">' + escapeHtml(l.label.trim()) + '</a>';
      }).join('');

      if (!orderToggle.dataset.bound) {
        orderToggle.dataset.bound = 'true';
        var floatWidget = document.getElementById('float-order');

        orderToggle.addEventListener('click', function (evt) {
          evt.stopPropagation();
          var isOpen = !floatMenu.hidden;
          floatMenu.hidden = isOpen;
          orderToggle.setAttribute('aria-expanded', String(!isOpen));
        });

        document.addEventListener('click', function (evt) {
          if (floatWidget && !floatWidget.contains(evt.target)) {
            floatMenu.hidden = true;
            orderToggle.setAttribute('aria-expanded', 'false');
          }
        });

        document.addEventListener('keydown', function (evt) {
          if (evt.key === 'Escape') {
            floatMenu.hidden = true;
            orderToggle.setAttribute('aria-expanded', 'false');
          }
        });
      }
    }

    syncFloatWidgetVisibility();
  }

  function isValidUrl(value) {
    if (!value || typeof value !== 'string') { return false; }
    var trimmed = value.trim();
    if (trimmed === '') { return false; }
    return /^https?:\/\//i.test(trimmed);
  }

  function escapeAttr(str) {
    return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function escapeHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function applyPhoneNumber(rawPhone) {
    var digits = String(rawPhone).replace(/[^\d+]/g, '');
    if (!digits) { return; }

    /* Si Google Sheets a interprété la cellule comme un NOMBRE plutôt
       que du texte, le zéro initial est perdu (ex. "0675766073" devient
       675766073, soit 9 chiffres au lieu de 10). On le restitue pour les
       numéros français standards (9 chiffres ne commençant pas par 0). */
    if (/^\+?\d+$/.test(digits) && digits.charAt(0) !== '+' && digits.length === 9) {
      digits = '0' + digits;
      console.warn('Rima — le numéro lu dans le Sheet semble avoir perdu son "0" initial (probablement enregistré comme nombre plutôt que texte dans Google Sheets). Le 0 a été restitué automatiquement, mais corrigez le format de la cellule "Téléphone" en "Texte brut" pour éviter ce contournement.');
    }

    var display = formatPhoneDisplay(digits);

    var ids = ['header-phone', 'contact-phone', 'traiteur-phone', 'footer-phone', 'mobile-nav-phone'];
    ids.forEach(function (id) {
      var el = document.getElementById(id);
      if (!el) { return; }
      el.setAttribute('href', 'tel:' + digits);
      if (id === 'contact-phone' || id === 'footer-phone') {
        el.textContent = display;
      }
      if (id === 'header-phone') {
        var numberSpan = el.querySelector('.header-call__number');
        if (numberSpan) { numberSpan.textContent = display; }
      }
      if (id === 'mobile-nav-phone') {
        var mobileNumberSpan = el.querySelector('.mobile-nav__call-number');
        if (mobileNumberSpan) { mobileNumberSpan.textContent = display; }
      }
    });
  }

  function formatPhoneDisplay(rawPhone) {
    var digits = String(rawPhone).replace(/\D/g, '');
    if (digits.length !== 10) { return rawPhone; }
    return digits.replace(/(\d{2})(?=\d)/g, '$1 ').trim();
  }

  function applyAddress(rawAddress) {
    var link = document.getElementById('address-link');
    if (!link) { return; }
    var encoded = encodeURIComponent(rawAddress);
    link.setAttribute('href', 'https://www.google.com/maps/search/?api=1&query=' + encoded);
    link.textContent = rawAddress;
  }

  /* ----------------------------------------------------------------
     3. La Carte — données du menu (en dur pour l'instant ; sera
        synchronisé depuis le Google Sheet dans une prochaine version,
        sans changement nécessaire de ce code de rendu)
     ---------------------------------------------------------------- */

  var MENU_DATA = [
    {
      category: 'Hors-d\'œuvre froid',
      dishes: [
        { name: 'Feuilles de vignes farcies végétariennes', unit: '(pièce)', price: '1,00 €', desc: 'Feuilles de vignes enroulées autour d\'un mélange parfumé de riz, tomates, persil et menthe, huile d\'olive.' },
        { name: 'Taboulé', price: '8,50 €', desc: 'Tomate, persil, blé concassé, huile d\'olive et citron — 370 ml.' },
        { name: 'Fattoush', price: '9,00 €', desc: 'Salade croquante de tomates, concombres, radis, laitue, parsemée de pain libanais grillé.' },
        { name: 'Hommos', price: '9,00 €', desc: 'Purée de pois chiches, crème de sésame, citron et huile d\'olive.' },
        { name: 'Moutabal', price: '9,00 €', desc: 'Caviar d\'aubergines, crème de sésame et citron.' },
        { name: 'Moussaka végétarienne', price: '9,00 €', desc: 'Aubergines fondantes, tomates, poivrons, oignons et pois chiches.' },
        { name: 'Labné', price: '9,00 €', desc: 'Fromage blanc au concombre, menthe et huile d\'olive.' },
        { name: 'Chanklish', price: '9,00 €', desc: 'Salade de fromage de brebis, tomates, oignons et thym, filet d\'huile d\'olive.' }
      ]
    },
    {
      category: 'Hors-d\'œuvre chaud',
      dishes: [
        { name: 'Samboussek viande', unit: '(pièce)', price: '3,50 €', desc: 'Petits chaussons dorés garnis de bœuf haché relevé aux oignons, pignons et épices.' },
        { name: 'Samboussek fromage', unit: '(pièce)', price: '3,50 €', desc: 'Petits chaussons dorés garnis de fromage fondant et de persil frais.' },
        { name: 'Rikakat', unit: '(pièce)', price: '3,00 €', desc: 'Fins rouleaux de pâte garnie de fromage fondant et de thym.' },
        { name: 'Fatayer épinards', unit: '(pièce)', price: '3,50 €', desc: 'Petits feuilletés triangulaires garnis d\'épinards, oignons et tomates, filet de citron.' },
        { name: 'Kebbé', unit: '(pièce)', price: '3,50 €', desc: 'Beignets dorés de blé concassé garnis de bœuf finement épicé, oignons et pignons.' },
        { name: 'Falafel', unit: '(pièce)', price: '3,50 €', desc: 'Boulettes croustillantes de pois chiches et fèves, accompagnées de leur sauce.' },
        { name: 'Kebbé au potiron', unit: '(pièce)', price: '3,50 €', desc: 'Beignets de potiron et blé concassé farcis d\'épinards, version végétarienne du kebbé viande.' }
      ]
    },
    {
      category: 'Sandwiches',
      dishes: [
        { name: 'Shawarma poulet', price: '11,00 €', desc: 'Pain libanais garni d\'émincé de poulet mariné, crudités et crème d\'ail.' },
        { name: 'Shawarma viande', price: '11,00 €', desc: 'Pain libanais garni de bœuf mariné émincé, oignons, tomates, persil et sauce.' },
        { name: 'Kafta', price: '11,00 €', desc: 'Pain libanais garni de brochettes de bœuf haché aux herbes fraîches et oignons grillés.' },
        { name: 'Chich-Taouk', price: '11,00 €', desc: 'Pain libanais garni d\'une brochette de poulet mariné au citron et à l\'ail, crudités et crème.' },
        { name: 'Falafel', price: '11,00 €', desc: 'Pain libanais garni de falafels croustillants, crudités et sauce crème de sésame.' },
        { name: 'Boisson', price: '2,00 €', desc: 'Coca, Ice Tea, eau gazeuse.' }
      ]
    },
    {
      category: 'Plats chauds',
      dishes: [
        { name: 'Mezzés & Grillades', price: '40,00 €', desc: 'Trois hors-d\'œuvres froids, quatre beignets chauds, une brochette kafta et chich-taouk.' },
        { name: 'Assiette grillades mixtes', price: '28,00 €', desc: 'Brochette chich-taouk, brochette kafta, émincés de shawarma, accompagnements.' },
        { name: 'Assiette shawarma viande', price: '22,00 €', desc: 'Émincés de bœuf mariné, crudités, crème de sésame et accompagnement.' },
        { name: 'Assiette shawarma poulet', price: '22,00 €', desc: 'Émincés de poulet mariné, blé concassé à la sauce tomate.' },
        { name: 'Assiette Kafta', price: '22,00 €', desc: 'Deux brochettes de bœuf haché aux herbes fraîches et oignons, blé concassé.' },
        { name: 'Chich-Taouk', price: '22,00 €', desc: '2 brochettes de poulet mariné, crème à l\'ail, blé concassé et hommos.' }
      ]
    },
    {
      category: 'Plat du jour',
      dishes: [
        { name: 'Plat du jour', price: '22,00 €', desc: 'Selon les produits du jour et la saison.' }
      ]
    },
    {
      category: 'Assiette mezze',
      dishes: [
        { name: 'Assiette Mézzé', price: '22,00 €', desc: 'Trois hors-d\'œuvres froids (hommos, moutabal, taboulé) et trois hors-d\'œuvres chauds.' }
      ]
    },
    {
      category: 'Desserts',
      dishes: [
        { name: 'Flan libanais — Mouhallabié', price: '6,00 €', desc: 'Flan à base de lait, fleur d\'oranger et éclats de pistache.' },
        { name: 'Ma\'moul', price: '3,50 €', desc: 'Gâteau fourré à la datte.' },
        { name: 'Gâteau aux pistaches', price: '4,00 €', desc: 'Gâteau aux pistaches.' },
        { name: 'Maamoul pistache', unit: '(1 pièce)', price: '3,50 €', desc: 'Biscuit à base de semoule, fourré à la pistache, sucre glace.' },
        { name: 'Maamoul noix', unit: '(1 pièce)', price: '3,50 €', desc: 'Biscuit à base de semoule, fourré à la noix, sucre glace.' },
        { name: 'Katayef', price: '6,00 €', desc: 'Petits pancakes moelleux fourrés aux noix, sirop de fleur d\'oranger.' },
        { name: 'Baklawa', price: '2,50 €', desc: 'Gâteau feuilleté croustillant, éclats de pistache, sirop de fleur d\'oranger.' }
      ]
    },
    {
      category: 'Boissons',
      dishes: [
        { name: 'Coca Cola', price: '2,00 €' },
        { name: 'Coca Zero', price: '2,00 €' },
        { name: 'Ayran', price: '2,00 €', desc: 'Boisson rafraîchissante à base de yaourt légèrement salé.' },
        { name: 'Badoit', price: '2,00 €', desc: 'Eau gazeuse.' },
        { name: 'Ice Tea Pêche', price: '2,00 €' },
        { name: 'Citronnade maison', price: '3,00 €' },
        { name: 'Jus de dattes maison', price: '3,00 €' }
      ]
    }
  ];

  function renderMenu(menuData) {
    var filtersEl = document.getElementById('carte-filters');
    var menuEl = document.getElementById('carte-menu');
    if (!filtersEl || !menuEl || !menuData || !menuData.length) { return; }

    var allLabel = 'Tout';
    var activeCategory = allLabel;

    function slug(str) {
      return String(str)
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-');
    }

    function buildFilters() {
      var labels = [allLabel].concat(menuData.map(function (g) { return g.category; }));
      filtersEl.innerHTML = labels.map(function (label) {
        var isActive = label === activeCategory;
        return '<button type="button" data-category="' + escapeAttr(label) + '"' +
          ' class="' + (isActive ? 'is-active' : '') + '"' +
          ' role="tab" aria-selected="' + isActive + '">' +
          escapeHtml(label) + '</button>';
      }).join('');

      filtersEl.querySelectorAll('button').forEach(function (btn) {
        btn.addEventListener('click', function () {
          activeCategory = btn.getAttribute('data-category');
          buildFilters();
          buildMenu();
          scrollFiltersIntoViewIfNeeded();
        });
      });
    }

    /* Recale la vue sur la barre de filtres UNIQUEMENT si elle est sortie
       du haut de l'écran (ex. après avoir lu plusieurs plats). Compense
       la hauteur du header fixe pour ne jamais masquer la première ligne
       de plats sous le bandeau. Si la barre est déjà visible, on ne
       scrolle pas du tout — évite l'effet "ça descend trop". */
    function scrollFiltersIntoViewIfNeeded() {
      var header = document.getElementById('site-header');
      var headerHeight = header ? header.offsetHeight : 0;
      var filtersTop = filtersEl.getBoundingClientRect().top;

      /* Marge de confort sous le header pour ne pas coller les pilules au bord. */
      var comfortMargin = 16;
      var minVisibleTop = headerHeight + comfortMargin;

      if (filtersTop < minVisibleTop) {
        var targetScroll = window.scrollY + filtersTop - minVisibleTop;
        window.scrollTo({ top: targetScroll, behavior: 'smooth' });
      }
      /* Si filtersTop est déjà >= minVisibleTop (barre visible et non masquée
         par le header), on ne touche à rien : pas de scroll inutile. */
    }

    function buildMenu() {
      var groupsToShow = activeCategory === allLabel
        ? menuData
        : menuData.filter(function (g) { return g.category === activeCategory; });

      menuEl.innerHTML = groupsToShow.map(function (group) {
        var dishesHtml = group.dishes.map(function (dish) {
          var nameWithUnit = escapeHtml(dish.name) + (dish.unit ? ' <span class="menu-dish__unit">' + escapeHtml(dish.unit) + '</span>' : '');
          var descHtml = dish.desc ? '<p class="menu-dish__desc">' + escapeHtml(dish.desc) + '</p>' : '';
          return (
            '<div class="menu-dish">' +
              '<div class="menu-dish__info">' +
                '<p class="menu-dish__name">' + nameWithUnit + '</p>' +
                descHtml +
              '</div>' +
              '<span class="menu-dish__price">' + escapeHtml(dish.price) + '</span>' +
            '</div>'
          );
        }).join('');

        return (
          '<div class="menu-group" id="menu-' + slug(group.category) + '">' +
            '<h3 class="menu-group__title">' + escapeHtml(group.category) + '</h3>' +
            '<div class="menu-group__divider" aria-hidden="true"></div>' +
            '<div class="menu-grid">' + dishesHtml + '</div>' +
          '</div>'
        );
      }).join('');
    }

    buildFilters();
    buildMenu();
  }

  /* ----------------------------------------------------------------
     4. Interactions UI
     ---------------------------------------------------------------- */

  function initHeaderScroll() {
    var header = document.getElementById('site-header');
    if (!header || header.dataset.scrollBound) { return; }
    header.dataset.scrollBound = 'true';

    function onScroll() {
      if (window.scrollY > 40) {
        header.classList.add('is-scrolled');
      } else {
        header.classList.remove('is-scrolled');
      }
    }
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  /**
   * Menu mobile : panneau latéral fixe (transform: translateX),
   * toujours présent dans le DOM, accessible à tout moment quel que
   * soit le défilement de la page. S'ouvre/se ferme en ré-appuyant sur
   * le même bouton burger (qui devient une croix), via le voile sombre
   * derrière le panneau, via un lien du menu, ou via la touche Échap.
   */
  function initMobileNav() {
    var toggle = document.getElementById('nav-toggle');
    var nav = document.getElementById('mobile-nav');
    var scrim = document.getElementById('nav-scrim');
    if (!toggle || !nav) { return; }
    if (toggle.dataset.bound) { return; } /* évite tout double-binding */
    toggle.dataset.bound = 'true';

    function openNav() {
      /* On retire d'abord [hidden] (sinon la règle globale
         [hidden]{display:none} empêche toute transition), puis on force
         un reflow avant d'ajouter .is-open pour que le translateX
         s'anime depuis sa position hors écran. */
      nav.hidden = false;
      if (scrim) { scrim.hidden = false; }
      /* reflow forcé : lecture d'une propriété de layout */
      void nav.offsetWidth;

      nav.classList.add('is-open');
      if (scrim) { scrim.classList.add('is-open'); }
      toggle.classList.add('is-active');
      toggle.setAttribute('aria-expanded', 'true');
      toggle.setAttribute('aria-label', 'Fermer le menu');
      document.body.classList.add('nav-locked');
      /* Le bouton flottant "Commander" et la carte d'alerte ont un
         z-index supérieur ; on les neutralise tant que le panneau est
         ouvert pour qu'ils n'interceptent pas les clics des liens. */
      document.body.classList.add('float-widgets-suspended');
    }

    function closeNav() {
      nav.classList.remove('is-open');
      toggle.classList.remove('is-active');
      toggle.setAttribute('aria-expanded', 'false');
      toggle.setAttribute('aria-label', 'Ouvrir le menu');
      document.body.classList.remove('nav-locked');
      document.body.classList.remove('float-widgets-suspended');
      if (scrim) { scrim.classList.remove('is-open'); }

      /* On remet [hidden] (panneau + scrim) APRÈS la transition de
         fermeture, pour qu'ils ne bloquent plus aucun clic une fois
         invisibles, sans couper l'animation de sortie. */
      window.setTimeout(function () {
        if (!nav.classList.contains('is-open')) {
          nav.hidden = true;
          if (scrim) { scrim.hidden = true; }
        }
      }, 400);
    }

    /* Le burger ouvre ET referme (ré-appui = fermeture). */
    toggle.addEventListener('click', function (evt) {
      evt.stopPropagation();
      if (nav.classList.contains('is-open')) {
        closeNav();
      } else {
        openNav();
      }
    });

    if (scrim) {
      scrim.addEventListener('click', closeNav);
    }

    /* Les liens d'ancre (#histoire...) ET le lien tel: fonctionnent
       normalement : le clic navigue/appelle ET referme le panneau. */
    nav.querySelectorAll('a').forEach(function (link) {
      link.addEventListener('click', closeNav);
    });

    document.addEventListener('keydown', function (evt) {
      if (evt.key === 'Escape' && nav.classList.contains('is-open')) {
        closeNav();
      }
    });

    window.addEventListener('resize', function () {
      if (window.innerWidth > 760 && nav.classList.contains('is-open')) {
        closeNav();
      }
    });
  }

  /**
   * Affiche/masque le panneau de la carte (filtres + plats) derrière un
   * bouton "Afficher la carte", pour éviter d'imposer un long défilement
   * à quelqu'un qui ne veut que jeter un œil au reste de la page.
   */
  function initCarteToggle() {
    var toggle = document.getElementById('carte-toggle');
    var label = document.getElementById('carte-toggle-label');
    var panel = document.getElementById('carte-panel');
    if (!toggle || !panel) { return; }
    if (toggle.dataset.bound) { return; }
    toggle.dataset.bound = 'true';

    toggle.addEventListener('click', function () {
      var isOpen = panel.hidden; /* on est en train d'OUVRIR si le panneau était caché */
      panel.hidden = !isOpen;
      toggle.setAttribute('aria-expanded', String(isOpen));
      if (label) { label.textContent = isOpen ? 'Masquer la carte' : 'Afficher la carte'; }

      if (!isOpen) {
        /* En refermant, on ramène la vue sur le haut de la section pour
           éviter de laisser la personne "perdue" plus bas dans une page
           qui vient de se raccourcir d'un coup. */
        var carteSection = document.getElementById('carte');
        if (carteSection) {
          carteSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      }
    });
  }

  function initRevealOnScroll() {
    var targets = document.querySelectorAll(
      '.histoire__grid, .menu-group, .traiteur__grid, .avis__card, .contact__grid'
    );
    if (!targets.length) { return; }

    targets.forEach(function (el) { el.classList.add('reveal'); });

    if (!('IntersectionObserver' in window)) {
      targets.forEach(function (el) { el.classList.add('is-visible'); });
      return;
    }

    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-visible');
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.1 }
    );

    targets.forEach(function (el) { observer.observe(el); });
  }

  /**
   * Calcule si le restaurant est actuellement ouvert, à partir des
   * horaires fournis dans le brief :
   * Lundi : Fermé / Mardi-Samedi : 12:00–23:00 / Dimanche : 11:30–15:00
   */
  function initOpeningStatus() {
    var dot = document.getElementById('hero-status-dot');
    var text = document.getElementById('hero-status-text');
    if (!dot || !text) { return; }

    var now = new Date();
    var day = now.getDay();
    var minutes = now.getHours() * 60 + now.getMinutes();

    var schedule = {
      0: [[11 * 60 + 30, 15 * 60]],
      1: [],
      2: [[12 * 60, 23 * 60]],
      3: [[12 * 60, 23 * 60]],
      4: [[12 * 60, 23 * 60]],
      5: [[12 * 60, 23 * 60]],
      6: [[12 * 60, 23 * 60]]
    };

    var ranges = schedule[day] || [];
    var isOpen = ranges.some(function (range) {
      return minutes >= range[0] && minutes < range[1];
    });

    if (isOpen) {
      dot.classList.add('is-open');
      text.textContent = 'Ouvert actuellement';
    } else {
      dot.classList.add('is-closed');
      text.textContent = 'Fermé pour le moment';
    }
  }

  var yearEl = document.getElementById('footer-year');
  if (yearEl) { yearEl.textContent = String(new Date().getFullYear()); }

})();
