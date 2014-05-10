function EndlessBattle() {
    this.moduleActive = true;
    this.name = "EndlessBattle";
    this.version = 1.4;
    this.baseUrl = FrozenBattle.baseUrl + '/Modules/EndlessBattle';
    this.scripts = [ FrozenBattle.baseUrl + '/data.js', FrozenBattle.baseUrl + '/core.js' ];

    this.settings = undefined;

    this.lastUpdateTime = Date.now();
    this.lastAttackTime = Date.now();
    this.lastStatsUpdate = Date.now();

    this.damageDealtSinceUpdate = 0;

    this.updateTimePassed = 0;

    // ---------------------------------------------------------------------------
    // main code
    // ---------------------------------------------------------------------------
    this.init = function() {
        this.settings = new FrozenBattle.EndlessBattleSettings();
        this.settings.load();

        if (game == undefined || game.itemCreator == undefined
                || game.itemCreator.createRandomItem == undefined) {
            FrozenUtils.log("Endless battle was not detected, disabling module!");
            this.moduleActive = false;
            return;
        }

        // Store the native methods
        game.native_update = update;
        game.native_createRandomItem = game.itemCreator.createRandomItem;
        game.native_save = game.save;
        game.native_load = game.load;
        game.player.native_getCritChance = game.player.getCritChance;
        game.mercenaryManager.native_purchaseMercenary = game.mercenaryManager.purchaseMercenary;
        game.monsterCreator.native_createRandomMonster = game.monsterCreator.createRandomMonster;
        

        // Override with our own
        update = this.onUpdate;
        game.itemCreator.createRandomItem = this.onCreateRandomItem;
        game.save = this.onSave;
        game.load = this.onLoad;
        game.player.getCritChance = this.onGetCritChance;
        game.mercenaryManager.purchaseMercenary = this.onPurchaseMercenary;
        game.monsterCreator.createRandomMonster = this.onCreateMonster;

        // Override item tooltips
        this.native_equipItemHover = equipItemHover;
        this.native_inventoryItemHover = inventoryItemHover;
        equipItemHover = this.onEquipItemHover;
        inventoryItemHover = this.onInventoryItemHover;

        // Override the formatter
        this.native_formatMoney = Number.prototype.formatMoney;
        Number.prototype.formatMoney = this.onFormatMoney;

        // Store some other variables from the core game
        this.minRarity = ItemRarity.COMMON;
        this.maxRarity = ItemRarity.LEGENDARY;

        this.initializeUI();

        this.temp_fixPlayerHealth();

        FrozenUtils.log("Endless battle module version " + this.getFullVersionString() + " loaded");
    }
    
    this.onCreateMonster = function(level, rarity) {
        if (game.monster) {
            game.monster.takeDamage = game.monster.native_takeDamage;
        }
        
        var newMonster = game.monsterCreator.native_createRandomMonster(level, rarity);
        
        // Hook the monsters take damage
        newMonster.native_takeDamage = newMonster.takeDamage;
        newMonster.takeDamage = FrozenBattle.EndlessBattle.onMonsterTakeDamage;
        
        return newMonster;
    }

    this.onMonsterTakeDamage = function(value) {
        game.monster.native_takeDamage(value);
        FrozenBattle.EndlessBattle.damageDealtSinceUpdate += value;
    }

    this.onPurchaseMercenary = function(type) {
        game.mercenaryManager.native_purchaseMercenary(type);
        FrozenBattle.EndlessBattle.updateUI();
    }

    this.onGetCritChance = function() {
        var chance = game.player.native_getCritChance();
        if (chance > 90) {
            return 90;
        }

        return chance;
    }

    this.onUpdate = function() {
        FrozenBattle.EndlessBattle.update();
    }

    this.onSave = function() {
        FrozenBattle.EndlessBattle.save();
    }

    this.onLoad = function() {
        FrozenBattle.EndlessBattle.load();
    }

    this.onFormatMoney = function(c, d, t) {
        var self = FrozenBattle.EndlessBattle;
        var formatterKey = FrozenCore.FormatterKeys[self.settings.numberFormatter];
        if (FrozenCore.Formatters[formatterKey] != undefined) {
            var formatter = FrozenCore.Formatters[formatterKey];
            return formatter(parseInt(this)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
        }
        else {
            return self.nativeFormatMoney(this, c, d, t);
        }
    }

    this.onEquipItemHover = function(obj, index) {
        var self = FrozenBattle.EndlessBattle;
        self.native_equipItemHover(obj, index);

        var item = game.inventory.slots[index - 1];
        if (!item) {
            return;
        }

        $("#itemTooltipSellValue").html(item.sellValue.formatMoney());
    }

    this.onInventoryItemHover = function(obj, index) {
        var self = FrozenBattle.EndlessBattle;
        self.native_inventoryItemHover(obj, index);

        var item = game.inventory.slots[index - 1];
        if (!item) {
            return;
        }

        $("#itemTooltipSellValue").html(item.sellValue.formatMoney(2));
        var equippedSlot = self.getItemSlotNumber(item.type);
        var item2 = game.equipment.slots[equippedSlot];
        if (item2) {
            $("#itemCompareTooltipSellValue").html(item2.sellValue.formatMoney(2));
        }
    }

    this.save = function() {
        game.native_save();

        this.settings.save();

        localStorage.fb_version = this.version;
    }

    this.load = function() {
        game.native_load();

        this.settings.load();
    }

    this.update = function() {
        game.native_update();

        if (!this.moduleActive || this.settings.disabled) {
            return;
        }

        var currentTime = Date.now();

        // Auto combat uses it's own timing
        this.autoCombat(currentTime);

        this.updateTimePassed += (currentTime - this.lastUpdateTime);
        if (this.updateTimePassed >= this.settings.updateInterval) {
            this.finishMonster(currentTime);
            this.autoSell(currentTime);
            this.updateTimePassed -= this.settings.updateInterval;
        }

        var timeSinceStatUpdate = currentTime - this.lastStatsUpdate;
        if (timeSinceStatUpdate > 1000) {
            this.updateStats();
            this.lastStatsUpdate = currentTime;
        }

        this.updateInterfaceOverrides();

        lastUpdateTime = currentTime;
    }

    this.finishMonster = function(time) {
        // This will only go into effect if the monster shows as 0 health to fix
        // floating health issues
        if (!game.inBattle || !game.monster.alive || game.monster.health >= 1) {
            return;
        }

        // Force the game to attack to resolve the dead monster
        game.monster.alive = false;
        game.attack();
    }

    this.autoCombat = function(time) {
        if (!this.settings.autoCombatActive) {
            return;
        }

        var autoAttackTime = this.getAutoAttackTime();
        if (time - this.lastAttackTime < autoAttackTime) {
            return;
        }

        this.lastAttackTime = time;

        // If we don't have enough health don't auto attack
        var healthThreshold = game.player.getMaxHealth() / 2;
        if (game.player.health < healthThreshold) {
            return;
        }

        // Ensure that we fight on the minimum level
        var targetLevel = game.player.level;
        if (this.settings.autoCombatKeepLevelDifference) {
            targetLevel = game.player.level - this.settings.autoCombatMaxLevelDifference;
        }
        else {
            targetLevel = this.settings.autoCombatLevel;
        }

        game.battleLevel = targetLevel;

        // Enter battle
        if (game.inBattle == false && game.player.alive) {
            game.enterBattle();
        }

        var doubleHitChance = this.getDoubleHitChance();
        var attacks = 1;
        if (Math.random() < doubleHitChance) {
            attacks++;
        }

        while (attacks >= 1) {
            this.addStat("Auto attacks");
            game.attack();
            attacks--;
        }
    }

    this.getAutoAttackTime = function() {
        var time = 10000;
        time -= game.mercenaryManager.footmenOwned * 10;
        time -= game.mercenaryManager.clericsOwned * 15;
        time -= game.mercenaryManager.magesOwned * 20;
        time -= game.mercenaryManager.thiefsOwned * 25;
        time -= game.mercenaryManager.warlocksOwned * 30;
        var multiplier = 1.0 + game.mercenaryManager.commandersOwned * 0.1;
        time /= multiplier;
        if (time < 10) {
            return 10;
        }

        return time / multiplier;
    }

    this.getDoubleHitChance = function() {
        var baseChance = 0.01;
        var chance = game.player.native_getCritChance();
        if (chance > 90) {
            baseChance += (chance - 90) / 1000;
        }

        return baseChance;
    }

    this.autoSell = function(time) {
        if (!this.settings.autoSellActive) {
            return;
        }

        // Check the inventory
        var freeSlots = 0;
        for (var slot = 0; slot < game.inventory.slots.length; slot++) {
            if (game.inventory.slots[slot] != null) {
                var item = game.inventory.slots[slot];
                var rarity = this.getRarityNumber(item.rarity);
                if (rarity >= this.settings.autoSellThreshold) {
                    continue;
                }

                if (this.settings.detailedLogging) {
                    FrozenUtils.log("sold " + this.getRarityString(rarity) + " " + item.name
                            + " for " + item.sellValue.formatMoney(2));
                }

                this.addStat("Items sold");
                this.addStat("Items sold for", item.sellValue);
                game.inventory.sellItem(slot);
            }
            else {
                freeSlots++;
            }
        }

        if (freeSlots == 0) {
            FrozenUtils.log("Inventory full, selling all items!");
            game.inventory.sellAll();
        }
    }

    this.onCreateRandomItem = function(level, rarity) {
        return FrozenBattle.EndlessBattle.createRandomItem(level, rarity);
    }

    this.createRandomItem = function(level, rarity) {
        var item = game.native_createRandomItem(level, rarity);
        if (item == null) {
            return null;
        }

        if (this.settings.enchantingEnabled) {
            this.enchantItem(item);
        }

        if (this.settings.improvedSalePriceEnabled) {
            this.updateSalePrice(item);
        }

        if (this.settings.detailedLogging) {
            FrozenUtils.log("Found " + item.name);
        }

        return item;
    }
    
    this.addStat = function(key, value) {
        if(value == undefined) value = 1;
        if(!this.settings.stats[key]) {
            this.settings.stats[key] = 0;
        }
        
        this.settings.stats[key] += value;
        this.updateInterfaceStats();
    }

    this.enchantItem = function(item) {
        var enchantChance = this.settings.enchantingBaseChance;
        var bonus = 0;
        while (Math.random() <= enchantChance) {
            bonus++;
            enchantChance /= 1.5;
        }

        if (bonus > 0) {
            this.addStat("Items enchanted");
            item.name += " +" + bonus;
            item.enchantLevel = bonus;
            var multiplier = 1 + (this.settings.enchantingBaseMultiplier * bonus);

            item.minDamage = parseInt(item.minDamage * multiplier);
            item.maxDamage = parseInt(item.maxDamage * multiplier);
            item.damageBonus = parseInt(item.damageBonus * multiplier);

            item.strength = parseInt(item.strength * multiplier);
            item.agility = parseInt(item.agility * multiplier);
            item.stamina = parseInt(item.stamina * multiplier);

            item.health = parseInt(item.health * multiplier);
            item.hp5 = parseInt(item.hp5 * multiplier);
            item.armour = parseInt(item.armour * multiplier);
            item.armourBonus = parseInt(item.armourBonus * multiplier);

            item.critChance = parseInt(item.critChance * multiplier);
            item.critDamage = parseInt(item.critDamage * multiplier);

            item.goldGain = parseInt(item.goldGain * multiplier);
            item.experienceGain = parseInt(item.experienceGain * multiplier);
        }
    }

    this.updateSalePrice = function(item) {
        baseSaleValue = Math.pow(item.level / 2, 3);
        item.sellValue = 0;

        var multiplier = 1;
        multiplier += this.updateSalePriceFor(item, item.damageBonus, 1, 0.15);

        multiplier += this.updateSalePriceFor(item, item.strength, 0.1, 0.1);
        multiplier += this.updateSalePriceFor(item, item.agility, 0.1, 0.1);
        multiplier += this.updateSalePriceFor(item, item.stamina, 0.1, 0.05);

        multiplier += this.updateSalePriceFor(item, item.health, 0.05, 0.01);
        multiplier += this.updateSalePriceFor(item, item.hp5, 0.05, 0.02);
        multiplier += this.updateSalePriceFor(item, item.armour, 0.05, 0.01);
        multiplier += this.updateSalePriceFor(item, item.armourBonus, 0.1, 0.05);

        multiplier += this.updateSalePriceFor(item, item.critChance, 1, 0.15);
        multiplier += this.updateSalePriceFor(item, item.critDamage, 0.5, 0.05);

        multiplier += this.updateSalePriceFor(item, item.goldGain, 0.01, 0.01);
        multiplier += this.updateSalePriceFor(item, item.experienceGain, 0.01, 0.01);

        multiplier += this.updateSalePriceFor(item, item.enchantLevel, 0, 0.2);

        if (multiplier == NaN) {
            return;
        }

        var multipliedBaseValue = parseInt(baseSaleValue * multiplier);
        item.sellValue += multipliedBaseValue;
    }

    this.updateSalePriceFor = function(item, value, multiplierAdd, multiplierQuality) {
        var current = item.sellValue;
        if (value == NaN || value == undefined || value == 0) {
            return 0;
        }

        current += parseInt(value * multiplierAdd);
        item.sellValue = current;
        return multiplierQuality;
    }

    this.getRarityNumber = function(rarity) {
        switch (rarity) {
            case ItemRarity.COMMON:
                return 0;
            case ItemRarity.UNCOMMON:
                return 1;
            case ItemRarity.RARE:
                return 2;
            case ItemRarity.EPIC:
                return 3;
            case ItemRarity.LEGENDARY:
                return 4;
        }
    }

    this.getRarityString = function(rarityNumber) {
        switch (rarityNumber) {
            case 0:
                return "Common";
            case 1:
                return "Uncommon";
            case 2:
                return "Rare";
            case 3:
                return "Epic";
            case 4:
                return "Legendary";
        }
    }

    this.getItemSlotNumber = function(type) {
        switch (type) {
            case ItemType.HELM:
                return 0;
            case ItemType.SHOULDERS:
                return 1;
            case ItemType.CHEST:
                return 2;
            case ItemType.LEGS:
                return 3;
            case ItemType.WEAPON:
                return 4;
            case ItemType.GLOVES:
                return 5;
            case ItemType.BOOTS:
                return 6;
            case ItemType.TRINKET:
                return 7;
            case ItemType.OFF_HAND:
                return 9;
        }
    }

    this.getFullVersionString = function() {
        return FrozenBattle.version + '.' + this.version;
    }

    // thanks to feildmaster @
    // http://feildmaster.com/feildmaster/scripts/EndlessImprovement/1.1/
    this.temp_fixPlayerHealth = function() {
        FrozenUtils.log("Applying player health fix (thanks to feildmaster)");

        game.player.baseHealthLevelUpBonus = 0;
        game.player.baseHp5LevelUpBonus = 0;

        // Add stats to the player for leveling up
        for (var x = 1; x < game.player.level; x++) {
            game.player.baseHealthLevelUpBonus += Math.floor(game.player.healthLevelUpBonusBase
                    * (Math.pow(1.15, x)));
            game.player.baseHp5LevelUpBonus += Math.floor(game.player.hp5LevelUpBonusBase
                    * (Math.pow(1.15, x)));
        }

        game.player.health = game.player.getMaxHealth();
    }

    this.sortInventory = function() {
        var order = {}
        for (var slot = 0; slot < game.inventory.slots.length; slot++) {
            if (game.inventory.slots[slot] != null) {
                var item = game.inventory.slots[slot];
                var orderValue = (this.getItemSlotNumber(item.type) * 100)
                        + this.getRarityNumber(item.rarity);
                if (!order[orderValue]) {
                    order[orderValue] = [];
                }

                order[orderValue].push(item);
            }
        }

        var keys = Object.keys(order);
        keys.sort();
        var currentSlot = 0;
        for (var i = 0; i < keys.length; i++) {
            for (var n = 0; n < order[keys[i]].length; n++) {
                game.inventory.slots[currentSlot++] = order[keys[i]][n];
            }
        }

        for (var slot = currentSlot; slot < game.inventory.slots.length; slot++) {
            game.inventory.slots[slot] = null;
        }

        this.refreshInventoryDisplay();
    }

    this.refreshInventoryDisplay = function() {
        for (var slot = 0; slot < game.inventory.slots.length; slot++) {
            if (game.inventory.slots[slot] != null) {
                var item = game.inventory.slots[slot];
                $("#inventoryItem" + (slot + 1)).css(
                        'background',
                        'url("includes/images/itemSheet2.png") ' + item.iconSourceX + 'px '
                                + item.iconSourceY + 'px');

            }
            else {
                $("#inventoryItem" + (slot + 1)).css('background',
                        'url("includes/images/NULL.png")');
            }

            // Fix the positioning, sometimes this can go wonky...
            var row = parseInt(slot / 5);
            var column = slot - (row * 5);
            $("#inventoryItem" + (slot + 1)).css('left', 4 + column * 41);
            $("#inventoryItem" + (slot + 1)).css('top', 29 + row * 41);
        }
    }

    this.nativeFormatMoney = function(n, c, d, t) {
        var c = isNaN(c = Math.abs(c)) ? 2 : c, d = d == undefined ? "." : d, t = t == undefined ? ","
                : t, s = n < 0 ? "-" : "", i = parseInt(n = Math.abs(+n || 0).toFixed(c)) + "", j = (j = i.length) > 3 ? j % 3
                : 0;
        return s + (j ? i.substr(0, j) + t : "") + i.substr(j).replace(/(\d{3})(?=\d)/g, "$1" + t)
                + (c ? d + Math.abs(n - i).toFixed(c).slice(2) : "");
    }

    this.updateStats = function() {
        this.settings.stats['DPS'] = this.damageDealtSinceUpdate;
        this.damageDealtSinceUpdate = 0;
        
        this.updateInterfaceStats();
    }

    // ---------------------------------------------------------------------------
    // User interface
    // ---------------------------------------------------------------------------
    this.initializeUI = function() {
        $('#version')
                .after(
                        $(
                                '<div id="fbVersion" style="color: #808080; padding: 5px 0px 5px 10px; float: left"/>')
                                .html('FB ' + this.getFullVersionString()));

        $('#inventoryWindowSellAllButton')
                .after(
                        $(
                                '<div id="inventoryWindowSortButton" class="button" style="font-family: \'Gentium Book Basic\'; position: absolute; left: 175px; top: 241px; line-height: 16px; color: #fff; font-size: 16px; text-shadow: 2px 0 0 #000, -2px 0 0 #000, 0 2px 0 #000, 0 -2px 0 #000, 1px 1px #000, -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000;"/>')
                                .addClass('button').html('Sort').click(this.onSortInventory));

        // Extended options
        $('#expBarOption').after(
                $('<div id="fbOptionNumberFormatting" class="optionsWindowOption"/>').click(
                        this.onToggleOptionNumberFormatting));
        $('#fbOptionNumberFormatting').after(
                $('<div id="fbOptionDetailedLogging" class="optionsWindowOption"/>').click(
                        function() {
                            FrozenBattle.EndlessBattle.onToggleBoolSetting("detailedLogging")
                        }));
        $('#fbOptionDetailedLogging').after(
                $('<div id="fbOptionEnchanting" class="optionsWindowOption"/>').click(function() {
                    FrozenBattle.EndlessBattle.onToggleBoolSetting("enchantingEnabled")
                }));
        $('#fbOptionEnchanting').after(
                $('<div id="fbOptionImprovedSalePrice" class="optionsWindowOption"/>').click(
                        function() {
                            FrozenBattle.EndlessBattle
                                    .onToggleBoolSetting("improvedSalePriceEnabled")
                        }));
        $('#fbOptionImprovedSalePrice').after(
                $('<div id="fbOptionFormatHealthBars" class="optionsWindowOption"/>').click(
                        function() {
                            FrozenBattle.EndlessBattle
                                    .onToggleBoolSetting("formatHealthBarNumbers")
                        }));

        // Auto combat screen
        var ondemandOptions = $('<div id="fbOnDemandOptions" class="navBarWindow" style="width:300px; height:200px; position: absolute; left:10px;top: 75px;margin: 0;"/>');
        $(document.body).append(ondemandOptions);
        ondemandOptions
                .append("<div class=\"navBarText\" style=\"padding: 5px 10px 5px 10px\">Frozen Battle Options</div");

        ondemandOptions
                .append($(
                        '<div id="autoCombatButton" class="navBarText" style="padding: 2px 10px 2px 10px"/>')
                        .addClass('button').click(function() {
                            FrozenBattle.EndlessBattle.onToggleBoolSetting("autoCombatActive")
                        }));

        ondemandOptions
                .append($(
                        '<div id="autoCombatKeepLevelDifferenceButton" class="navBarText" style="padding: 2px 10px 2px 20px"/>')
                        .addClass('button').click(
                                function() {
                                    FrozenBattle.EndlessBattle
                                            .onToggleBoolSetting("autoCombatKeepLevelDifference")
                                }));

        var autoCombatLevelDifference = $('<div id="autoCombatLevelDifference" style="padding: 2px 10px 2px 10px;">');
        ondemandOptions.append(autoCombatLevelDifference);

        autoCombatLevelDifference
                .append(
                        $('<div class="navBarText" style="padding: 2px 10px 2px 10px;float:left">- Level range: </div>'))
                .append(
                        $(
                                '<div id="autoCombatLevelDifferenceDown" class="battleLevelButton button" style="margin:0;position: relative;left:0px; top:0px; float:left; background: url(\'includes/images/battleLevelButton.png\') 0 25px">-</button>')
                                .click(function() {
                                    FrozenBattle.EndlessBattle.onModifyBattleLevelDifference(-1);
                                }))
                .append(
                        $('<div id="autoCombatLevelDifferenceText" class="navBarText" style="padding: 2px 10px 2px 10px;float:left">N/A</div>'))
                .append(
                        $(
                                '<div id="autoCombatLevelDifferenceUp" class="battleLevelButton button" style="margin:0;position: relative;left:0px; top:0px;float:left">+</button>')
                                .click(function() {
                                    FrozenBattle.EndlessBattle.onModifyBattleLevelDifference(1);
                                })).append($('<div style="clear:both;"/>'));

        var autoCombatLevel = $('<div id="autoCombatLevel" style="padding: 2px 10px 2px 10px;">');
        ondemandOptions.append(autoCombatLevel);

        autoCombatLevel
                .append(
                        $('<div class="navBarText" style="padding: 2px 10px 2px 10px;float:left">- Level: </div>'))
                .append(
                        $(
                                '<div id="autoCombatLevelDown" class="battleLevelButton button" style="margin:0;position: relative;left:0px; top:0px; float:left; background: url(\'includes/images/battleLevelButton.png\') 0 25px">-</button>')
                                .click(function() {
                                    FrozenBattle.EndlessBattle.onModifyBattleLevel(-1);
                                }))
                .append(
                        $('<div id="autoCombatLevelText" class="navBarText" style="padding: 2px 10px 2px 10px;float:left">N/A</div>'))
                .append(
                        $(
                                '<div id="autoCombatLevelUp" class="battleLevelButton button" style="margin:0;position: relative;left:0px; top:0px;float:left">+</button>')
                                .click(function() {
                                    FrozenBattle.EndlessBattle.onModifyBattleLevel(1);
                                })).append($('<div style="clear:both;"/>'));

        ondemandOptions.append($(
                '<div id="autoSellButton" class="navBarText" style="padding: 2px 10px 2px 10px"/>')
                .addClass('button').click(function() {
                    FrozenBattle.EndlessBattle.onToggleBoolSetting("autoSellActive")
                }));

        ondemandOptions
                .append($(
                        '<div id="autoSellThresholdButton" class="navBarText" style="padding: 2px 10px 2px 20px"/>')
                        .addClass('button').click(this.onToggleAutoSellThreshold));

        // Extra Stats screen
        var extraStats = $('<div id="fbExtraStatsWindow" class="navBarWindow" style="width:300px; height:500px; position: absolute; left:10px;top: 300px;margin: 0;"/>');
        $(document.body).append(extraStats);
        extraStats
                .append('<div class="navBarText" style="padding: 5px 120px 5px 10px; float: left">Frozen Battle Stats</div>');
        extraStats.append('<div class="navBarText" style="padding: 5px 10px 5px 10px">Clear</div>')
                .click(this.onClearStats);

        extraStats.append('<div id="fbExtraStats" style="padding: 5px 10px 5px 10px"/>');

        FrozenUtils.logCallback = this.onLog;

        this.updateUI();
        this.updateInterfaceStats();
    }

    this.onClearStats = function(value) {
        var self = FrozenBattle.EndlessBattle;
        self.settings.stats = {};
        self.updateInterfaceStats();
    }

    this.onModifyBattleLevel = function(value) {
        var self = FrozenBattle.EndlessBattle;
        self.settings.autoCombatLevel += value;
        if (self.settings.autoCombatLevel < 0) {
            self.settings.autoCombatLevel = 0;
        }
        if (self.settings.autoCombatLevel >= game.player.level) {
            self.settings.autoCombatLevel = game.player.level - 1;
        }
        self.updateUI();
    }

    this.onModifyBattleLevelDifference = function(value) {
        var self = FrozenBattle.EndlessBattle;
        self.settings.autoCombatMaxLevelDifference += value;
        if (self.settings.autoCombatMaxLevelDifference < 0) {
            self.settings.autoCombatMaxLevelDifference = 0;
        }
        if (self.settings.autoCombatMaxLevelDifference >= game.player.level) {
            self.settings.autoCombatMaxLevelDifference = game.player.level - 1;
        }
        self.updateUI();
    }

    this.onToggleBoolSetting = function(setting) {
        var self = FrozenBattle.EndlessBattle;
        self.settings[setting] = !self.settings[setting];
        self.updateUI();
    }

    this.onToggleAutoSellThreshold = function() {
        var self = FrozenBattle.EndlessBattle;
        if (self.settings.autoSellThreshold <= self.getRarityNumber(self.maxRarity)) {
            self.settings.autoSellThreshold++;
        }
        else {
            self.settings.autoSellThreshold = self.getRarityNumber(self.minRarity);
        }
        self.updateUI();
    }

    this.onToggleOptionNumberFormatting = function() {
        var self = FrozenBattle.EndlessBattle;
        if (self.settings.numberFormatter >= FrozenCore.FormatterKeys.length - 1) {
            self.settings.numberFormatter = 0;
        }
        else {
            self.settings.numberFormatter++;
        }

        self.updateMercenarySalePrices();
        self.updateUI();
    }

    this.onSortInventory = function() {
        FrozenBattle.EndlessBattle.sortInventory();
    }

    this.updateMercenarySalePrices = function() {
        $("#footmanCost").text(game.mercenaryManager.footmanPrice.formatMoney(0));
        $("#clericCost").text(game.mercenaryManager.clericPrice.formatMoney(0));
        $("#commanderCost").text(game.mercenaryManager.commanderPrice.formatMoney(0));
        $("#mageCost").text(game.mercenaryManager.magePrice.formatMoney(0));
        $("#thiefCost").text(game.mercenaryManager.thiefPrice.formatMoney(0));
        $("#warlockCost").text(game.mercenaryManager.warlockPrice.formatMoney(0));
    }

    this.updateUI = function() {
        if (this.settings.autoCombatActive) {
            var attackTime = FrozenUtils.timeDisplay(this.getAutoAttackTime(), true);
            $("#autoCombatButton").text(
                    'Auto combat: ' + this.getBoolDisplayText(this.settings.autoCombatActive)
                            + ' (every ' + attackTime + ')');
            $("#autoCombatKeepLevelDifferenceButton").show();
            $("#autoCombatKeepLevelDifferenceButton").text(
                    '- Keep combat level in range: '
                            + this.getBoolDisplayText(this.settings.autoCombatKeepLevelDifference));
            if (this.settings.autoCombatKeepLevelDifference) {
                $("#autoCombatLevel").hide();
                $("#autoCombatLevelDifference").show();
                $("#autoCombatLevelDifferenceText")
                        .text(this.settings.autoCombatMaxLevelDifference);
            }
            else {
                $("#autoCombatLevel").show();
                $("#autoCombatLevelDifference").hide();
                $("#autoCombatLevelText").text(this.settings.autoCombatLevel);
            }
        }
        else {
            $("#autoCombatButton").text(
                    'Auto combat: ' + this.getBoolDisplayText(this.settings.autoCombatActive));
            $("#autoCombatKeepLevelDifferenceButton").hide();
            $("#autoCombatLevelDifference").hide();
            $("#autoCombatLevel").hide();
        }

        $("#autoSellButton").text(
                'Auto sell: ' + this.getBoolDisplayText(this.settings.autoSellActive));
        $("#fbOptionDetailedLogging").text(
                "Detailed logging: " + this.getBoolDisplayText(this.settings.detailedLogging));
        $("#fbOptionEnchanting").text(
                "Enchanting: " + this.getBoolDisplayText(this.settings.enchantingEnabled));
        $("#fbOptionImprovedSalePrice").text(
                "Improved sale price: "
                        + this.getBoolDisplayText(this.settings.improvedSalePriceEnabled));
        $("#fbOptionNumberFormatting").text(
                "Format numbers: " + FrozenCore.FormatterKeys[this.settings.numberFormatter]);
        $("#fbOptionFormatHealthBars").text(
                "Format health bars: "
                        + this.getBoolDisplayText(this.settings.formatHealthBarNumbers));

        var autoSellThresholdText = "";
        if (this.settings.autoSellActive) {
            if (this.settings.autoSellThreshold > this.getRarityNumber(this.maxRarity)) {
                autoSellThresholdText = "All";
            }
            else {
                autoSellThresholdText = '- Sell below '
                        + this.getRarityString(this.settings.autoSellThreshold);
            }

            $("#autoSellThresholdButton").show();
            $("#autoSellThresholdButton").text(autoSellThresholdText);
        }
        else {
            $("#autoSellThresholdButton").hide();
        }        
    }
    
    this.updateInterfaceStats = function() {
        $("#fbExtraStats").empty();
        for (key in this.settings.stats) {
            $("#fbExtraStats").append(
                    '<div class="navBarText" style="padding: 5px 100px 5px 10px; float:left;width:100px">'
                            + key + '</div>');
            $("#fbExtraStats").append(
                    '<div class="navBarText" style="padding: 5px 10px 5px 10px">'
                            + this.settings.stats[key].formatMoney(2) + '</div>');
        }
    }

    this.updateInterfaceOverrides = function(value) {
        if (this.settings.formatHealthBarNumbers) {
            // Set player HP with formatting
            var playerHp = Math.floor(game.player.health).formatMoney(2);
            var playerMaxHp = Math.floor(game.player.getMaxHealth()).formatMoney(2);
            $("#playerHealthBarText").text(playerHp + '/' + playerMaxHp);

            // Set monster HP with formatting
            if (game.displayMonsterHealth && game.monster) {
                var monsterHp = Math.floor(game.monster.health).formatMoney(2);
                var monsterMaxHp = Math.floor(game.monster.maxHealth).formatMoney(2);
                $("#monsterName").text(monsterHp + '/' + monsterMaxHp);
            }
        }
    }

    this.getBoolDisplayText = function(value) {
        return value ? 'ON' : 'OFF';
    }
}

// ---------------------------------------------------------------------------
// module initialization
// ---------------------------------------------------------------------------
FrozenBattle.EndlessBattleModule = function EndlessBattleModule() {
    this.main = function() {
        FrozenBattle.EndlessBattle = new EndlessBattle();

        var includes = [ FrozenBattle.EndlessBattle.baseUrl + "/data.js",
                FrozenBattle.EndlessBattle.baseUrl + '/layout.css' ];
        FrozenUtils.loadScripts(includes, 0, function() {
            FrozenBattle.EndlessBattle.init()
        });
    }
}