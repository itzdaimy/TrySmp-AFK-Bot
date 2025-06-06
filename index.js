require('dotenv').config();
const mineflayer = require('mineflayer');
const { Client, GatewayIntentBits, Events, REST, Routes, SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const os = require('os');
const si = require('systeminformation');

// --- CONFIGURATION ---
const USE_DMS_FOR_OWNER = false; 

// --- DO NOT TOUCH BELOW THIS LINE UNLESS YOU KNOW WHAT YOUR DOING ---
let reconnecting = false;
let bot = null; 
let afkIntervalId = null;
let manualStop = false;
let discordClient;
let statusMessage = null;

let botMoneyBalance = 0;
let botGemBalance = 0;
let requestingBotMoneyBalance = false;
let requestingBotGemBalance = false;
let botMoneyBalanceLastUpdated = 0;
let botGemBalanceLastUpdated = 0;

let pendingBalanceRequest = null;
let pendingGemBalanceRequest = null;

let resolveMoneyPromise = null;
let rejectMoneyPromise = null;
let resolveGemPromise = null;
let rejectGemPromise = null;

let expectedDisconnect = false;

let pendingSayInteraction = null;

const BALANCE_UPDATE_INTERVAL = 30000;
const AFK_INTERVAL = 30 * 1000;

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID;
const DISCORD_OWNER_ID = process.env.DISCORD_OWNER_ID;
const DISCORD_STATUS_CHANNEL_ID = process.env.DISCORD_STATUS_CHANNEL_ID;

function formatNumberShort(num) {
  if (num === undefined || num === null || isNaN(Number(num))) return 'N/A';
  const n = Number(num);
  if (n >= 1e12) return (n / 1e12).toFixed(2).replace(/\.00$/, '') + 't';
  if (n >= 1e9) return (n / 1e9).toFixed(2).replace(/\.00$/, '') + 'b';
  if (n >= 1e6) return (n / 1e6).toFixed(2).replace(/\.00$/, '') + 'm';
  if (n >= 1e3) return (n / 1e3).toFixed(2).replace(/\.00$/, '') + 'k';
  return Math.floor(n).toString();
}

function formatUptime(totalSeconds) {
    if (isNaN(totalSeconds) || totalSeconds < 0) return "N/A";
    const days = Math.floor(totalSeconds / (3600 * 24)); totalSeconds %= (3600 * 24);
    const hours = Math.floor(totalSeconds / 3600); totalSeconds %= 3600;
    const minutes = Math.floor(totalSeconds / 60); const seconds = Math.floor(totalSeconds % 60);
    return `${days}d ${hours}h ${minutes}m ${seconds}s`;
}

function parseMoneyAmount(amountStr) {
  if (amountStr === undefined || amountStr === null) return 0;
  let str = String(amountStr).replace(/,/g, '').toLowerCase().replace(/\s/g, '').replace(/\$/g, '');
  const suffixMultipliers = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 };
  const match = str.match(/^([\d.]+)([kmbt])?$/);
  if (match) {
    const numberPart = parseFloat(match[1]);
    const suffix = match[2];
    if (isNaN(numberPart)) return 0;
    return numberPart * (suffix ? suffixMultipliers[suffix] : 1);
  }
  const num = parseFloat(str);
  return !isNaN(num) ? num : 0;
}

function parseGemAmount(amountStr) {
  if (amountStr === undefined || amountStr === null) return 0;
  let str = String(amountStr).replace(/,/g, '').toLowerCase().replace(/\s/g, '');
  const suffixMultipliers = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 };
  const match = str.match(/^([\d.]+)([kmbt])?$/);
  if (match) {
    const numberPart = parseFloat(match[1]);
    const suffix = match[2];
    if (isNaN(numberPart)) return 0;
    return Math.floor(numberPart * (suffix ? suffixMultipliers[suffix] : 1));
  }
  const num = parseInt(str);
  return !isNaN(num) ? num : 0;
}


async function tryToEat(foodName) {
  if (!bot || !bot.inventory || !bot.health || bot.food === 20) return;
  const foodItem = bot.inventory.items().find(item => item.name.includes(foodName));
  if (!foodItem) { console.log(`[BOT] No ${foodName} found for auto-eating.`); return; }
  if (bot.isEating) { console.log('[BOT] Already eating, skipping auto-eat.'); return; }
  bot.isEating = true;
  console.log(`[BOT] Attempting to eat ${foodName}...`);
  try {
    await bot.equip(foodItem, 'hand'); await bot.consume();
    console.log(`[BOT] Successfully consumed ${foodName}.`);
  } catch (err) {
    console.error(`[BOT] Error eating ${foodName}: ${err.message}`);
  }
  finally { bot.isEating = false; }
}

function startAutoEat() {
  if (!bot) return;
  console.log('[BOT] Starting auto-eat interval...');
  setInterval(async () => {
    if (!bot || !bot.health || bot.food === 20 || !bot.autoEatThreshold || bot.food >= bot.autoEatThreshold) return;
    console.log(`[BOT] Food level ${bot.food} is below threshold ${bot.autoEatThreshold}. Attempting to eat.`);
    await tryToEat('cooked_beef');
  }, 2000);
}

function startAntiAFK() {
    if (afkIntervalId) clearInterval(afkIntervalId);
    console.log('[BOT] Starting anti-AFK interval...');
    afkIntervalId = setInterval(() => {
        if (bot && bot.player) {
          console.log('[BOT] Anti-AFK: Jumping...');
          bot.setControlState('jump', true);
          setTimeout(() => { if (bot) bot.setControlState('jump', false); }, 100);
        }
        else {
          console.log('[BOT] Anti-AFK: Bot not spawned, stopping interval.');
          clearInterval(afkIntervalId);
          afkIntervalId = null;
        }
    }, AFK_INTERVAL);
}

function stopAntiAFK() {
    if (afkIntervalId) {
      console.log('[BOT] Stopping anti-AFK interval.');
      clearInterval(afkIntervalId);
      afkIntervalId = null;
    }
}

function updateBotBalances() {
    if (bot && bot.player) {
        const now = Date.now();
        if (!requestingBotMoneyBalance && (now - botMoneyBalanceLastUpdated > BALANCE_UPDATE_INTERVAL)) {
            console.log('[BOT] Requesting money balance...');
            bot.chat('/bal');
            requestingBotMoneyBalance = true;
            pendingBalanceRequest = setTimeout(() => {
              if (requestingBotMoneyBalance) {
                console.warn('[BOT] Money balance request timed out.');
                requestingBotMoneyBalance = false;
                pendingBalanceRequest = null;
              }
            }, 7000);
        }
        if (!requestingBotGemBalance && (now - botGemBalanceLastUpdated > BALANCE_UPDATE_INTERVAL)) {
            console.log('[BOT] Requesting gem balance...');
            bot.chat('/gems balance');
            requestingBotGemBalance = true;
            pendingGemBalanceRequest = setTimeout(() => {
              if (requestingBotGemBalance) {
                console.warn('[BOT] Gem balance request timed out.');
                requestingBotGemBalance = false;
                pendingGemBalanceRequest = null;
              }
            }, 7000);
        }
    } else {
      console.log('[BOT] Not updating balances: bot not spawned.');
    }
}

function requestMoneyBalanceOnce() {
    return new Promise((resolve, reject) => {
        if (!bot || !bot.player) return reject(new Error('Minecraft bot is not online.'));
        if (requestingBotMoneyBalance) {
            return reject(new Error('Money balance request already in progress. Please wait.'));
        }

        requestingBotMoneyBalance = true;
        resolveMoneyPromise = resolve;
        rejectMoneyPromise = reject;

        bot.chat('/bal');
        pendingBalanceRequest = setTimeout(() => {
            if (requestingBotMoneyBalance) {
                console.warn('[BOT] Money balance request timed out (one-time).');
                requestingBotMoneyBalance = false;
                pendingBalanceRequest = null;
                if (rejectMoneyPromise) {
                    rejectMoneyPromise(new Error('Money balance request timed out.'));
                    resolveMoneyPromise = null;
                    rejectMoneyPromise = null;
                }
            }
        }, 10000);
    });
}

function requestGemBalanceOnce() {
    return new Promise((resolve, reject) => {
        if (!bot || !bot.player) return reject(new Error('Minecraft bot is not online.'));
        if (requestingBotGemBalance) {
            return reject(new Error('Gem balance request already in progress. Please wait.'));
        }

        requestingBotGemBalance = true;
        resolveGemPromise = resolve;
        rejectGemPromise = reject;

        bot.chat('/gems balance');
        pendingGemBalanceRequest = setTimeout(() => {
            if (requestingBotGemBalance) {
                console.warn('[BOT] Gem balance request timed out (one-time).');
                requestingBotGemBalance = false;
                pendingGemBalanceRequest = null;
                if (rejectGemPromise) {
                    rejectGemPromise(new Error('Gem balance request timed out.'));
                    resolveGemPromise = null;
                    rejectGemPromise = null;
                }
            }
        }, 10000);
    });
}

async function sendOrEditStatusEmbed() {
    if (!discordClient || !discordClient.isReady()) {
        console.log('[DISCORD] Client not ready for status embed.');
        return;
    }

    console.log('[DISCORD] Preparing status embed...');
    const botStatus = bot && bot.player ? '🟢 Online' : '🔴 Offline';
    const statusColor = bot && bot.player ? '#2ECC71' : '#E74C3C';
    let systemInfoString = "System Info: `Loading...`";
    try {
        const mem = await si.mem();
        const currentLoad = await si.currentLoad();
        const uptime = os.uptime();
        systemInfoString = `RAM: \`${(mem.active / (1024**3)).toFixed(2)}GB / ${(mem.total / (1024**3)).toFixed(2)}GB\`\n` +
                           `CPU: \`${currentLoad.currentLoad.toFixed(2)}%\`\n` + `Uptime: \`${formatUptime(uptime)}\``;
    } catch (err) {
        console.error(`[DISCORD] Error fetching system info: ${err.message}`);
        systemInfoString = "System Info: `Error fetching data`";
    }

    const statusEmbed = new EmbedBuilder().setColor(statusColor).setTitle('Bot Status')
        .setDescription(`**Bot Status:** **${botStatus}**\n**Money Balance:** ${formatNumberShort(botMoneyBalance)}\n**Gem Balance:** ${formatNumberShort(botGemBalance)}\n\n${systemInfoString}`)
        .setTimestamp().setFooter({ text: 'Bot | IGN: daimyh' });

    let channel;
    try {
        if (USE_DMS_FOR_OWNER) {
            const owner = await discordClient.users.fetch(DISCORD_OWNER_ID);
            channel = await owner.createDM();
        } else {
            channel = discordClient.channels.cache.get(DISCORD_STATUS_CHANNEL_ID);
        }

        if (!channel) {
            const target = USE_DMS_FOR_OWNER ? `owner DMs (${DISCORD_OWNER_ID})` : `channel (${DISCORD_STATUS_CHANNEL_ID})`;
            console.error(`[DISCORD] Could not find target ${target}.`);
            return;
        }
    } catch (err) {
        console.error(`[DISCORD] Failed to get target channel/DM: ${err.message}`);
        return;
    }

    try {
        if (statusMessage && statusMessage.channelId === channel.id) {
            try {
                await statusMessage.edit({ embeds: [statusEmbed] });
                console.log(`[DISCORD] Status embed edited in ${USE_DMS_FOR_OWNER ? 'DMs' : 'channel'}.`);
                return; 
            } catch (error) {
                console.warn(`[DISCORD] Failed to edit stored status message (ID: ${statusMessage.id}). It may have been deleted. Will find/send a new one.`);
                statusMessage = null; 
            }
        }

        const messages = await channel.messages.fetch({ limit: 50 });
        const lastStatusMessage = messages.find(m =>
            m.author.id === discordClient.user.id && m.embeds.length > 0 && m.embeds[0].title === 'Bot Status'
        );

        if (lastStatusMessage) {
            statusMessage = await lastStatusMessage.edit({ embeds: [statusEmbed] });
            console.log(`[DISCORD] Found and edited previous status embed in ${USE_DMS_FOR_OWNER ? 'DMs' : 'channel'}.`);
        } else {
            statusMessage = await channel.send({ embeds: [statusEmbed] });
            console.log(`[DISCORD] Sent new status embed to ${USE_DMS_FOR_OWNER ? 'DMs' : 'channel'}.`);
        }
    } catch (err) {
        console.error(`[DISCORD] Fatal error sending/editing status embed: ${err.message}`);
        statusMessage = null;
    }
}


function createBot() {
  if (bot) { console.log('[BOT] Bot instance already exists, not creating a new one.'); return; }
  if (manualStop) { console.log('[BOT] Manual stop is active, not creating bot.'); return; }
  console.log(`[BOT] Attempting to create Minecraft bot for ${process.env.MC_EMAIL}...`);
  bot = mineflayer.createBot({
    host: process.env.MC_HOST, port: parseInt(process.env.MC_PORT), username: process.env.MC_EMAIL,
    auth: 'microsoft', version: '1.20.4', checkTimeoutInterval: 60 * 1000, defaultChatPatterns: true,
  });

  bot.on('spawn', () => {
    console.log(`[BOT] Bot spawned! IGN: ${bot.username}`);
    sendOrEditStatusEmbed();
    bot.tasksInitialized = false; 
    setTimeout(() => {
        if (!bot) { console.log('[BOT] Bot instance lost before sending queue command.'); return; }
        expectedDisconnect = true; 
        bot.chat('/queue economy-euc');
        console.log('[BOT] Sent /queue economy-euc command. Waiting for server confirmation...');
    }, 3000);
  });

  bot.on('message', (jsonMsg) => {
    if (!bot) return;
    const msg = jsonMsg.toString();
    console.log(`[BOT_CHAT] Received message: ${msg}`);

    if (((msg.includes("You are already on the server economy-euc.") || msg.includes("Sending you to economy-euc...")) || msg.includes("You have been added to the queue for economy-euc")) && !bot.tasksInitialized) {
        console.log('[BOT] Confirmed on economy-euc server. Initializing tasks...');
        expectedDisconnect = false; 
        updateBotBalances();
        if (!bot.balanceUpdateInterval) {
            console.log('[BOT] Starting balance update interval.');
            bot.balanceUpdateInterval = setInterval(updateBotBalances, BALANCE_UPDATE_INTERVAL);
        }
        startAntiAFK();
        bot.autoEatThreshold = 16;
        startAutoEat();
        bot.tasksInitialized = true;
        console.log('[BOT] Tasks initialized after server confirmation.');
        return;
    }

    const botGemBalanceMatch = msg.match(/Your balance is ([\d\s,.kmbtKMBT]+) gems/i);
    if (botGemBalanceMatch && requestingBotGemBalance) {
        const balanceStr = botGemBalanceMatch[1].trim();
        const parsedGems = parseGemAmount(balanceStr);
        console.log(`[BOT_CHAT] Detected gem balance: "${balanceStr}", Parsed: ${parsedGems}`);
        botGemBalance = parsedGems;
        requestingBotGemBalance = false;
        botGemBalanceLastUpdated = Date.now();
        if (pendingGemBalanceRequest) {
            clearTimeout(pendingGemBalanceRequest);
            pendingGemBalanceRequest = null;
        }
        if (resolveGemPromise) { 
            resolveGemPromise(parsedGems);
            resolveGemPromise = null;
            rejectGemPromise = null;
        }
        sendOrEditStatusEmbed();
        return;
    }

    const botMoneyBalanceMatch = msg.match(/Your balance is \$?([\d\s,.kmbtKMBT]+)(?! gems)/i);
    if (botMoneyBalanceMatch && requestingBotMoneyBalance) {
        if (msg.toLowerCase().includes('gems')) {
          console.log('[BOT_CHAT] Money balance match ignored: message contains "gems".');
          return;
        }
        const balanceStr = botMoneyBalanceMatch[1].trim();
        const parsedMoney = parseMoneyAmount(balanceStr);
        console.log(`[BOT_CHAT] Detected money balance: "${balanceStr}", Parsed: ${parsedMoney}`);
        botMoneyBalance = parsedMoney;
        requestingBotMoneyBalance = false;
        botMoneyBalanceLastUpdated = Date.now();
        if (pendingBalanceRequest) { 
            clearTimeout(pendingBalanceRequest);
            pendingBalanceRequest = null;
        }
        if (resolveMoneyPromise) { 
            resolveMoneyPromise(parsedMoney);
            resolveMoneyPromise = null;
            rejectMoneyPromise = null;
        }
        sendOrEditStatusEmbed();
        return;
    }

    if (pendingSayInteraction && msg.includes('TrySmp »')) {
        console.log(`[BOT_CHAT] Detected "TrySmp" message for /say command: ${msg}`);
        const interactionToReply = pendingSayInteraction;
        pendingSayInteraction = null; 

        const responseEmbed = new EmbedBuilder()
            .setColor('#2ECC71')
            .setTitle('Minecraft Response')
            .setDescription(`The bot said its message and received the following response:\n\n\`\`\`${msg}\`\`\``)
            .setTimestamp();

        if (USE_DMS_FOR_OWNER) {
            interactionToReply.user.send({ embeds: [responseEmbed] }).catch(err => console.error(`[DISCORD] Failed to send /say response to DM: ${err.message}`));
            interactionToReply.editReply({ content: 'Response received from Minecraft. Check your DMs.', ephemeral: true });
        } else {
            interactionToReply.editReply({ embeds: [responseEmbed], ephemeral: false });
        }
    }
  });

  bot.on('kicked', (reason) => {
    console.warn(`[BOT] Kicked from Minecraft server. Reason: ${reason}`);
    if (expectedDisconnect) {
        console.log('[BOT] Expected disconnect due to server transfer. Not attempting immediate reconnect.');
        expectedDisconnect = false; 
        reconnecting = false; 
        return;
    }
    if (!manualStop) {
        if (reconnecting) { console.log('[BOT] Already reconnecting, ignoring new kick event.'); return; }
        reconnecting = true;
        console.log('[BOT] Attempting to reconnect in 5 seconds...');
        setTimeout(() => {
            createBot();
            reconnecting = false;
        }, 5000); 
    }
    sendOrEditStatusEmbed();
  });

  bot.on('error', (err) => {
    console.error(`[BOT_ERROR] Minecraft bot error: ${err.message}`);
    if (expectedDisconnect) {
        console.log('[BOT] Error during expected disconnect (server transfer). Not attempting immediate reconnect.');
        expectedDisconnect = false;
        reconnecting = false; 
        return;
    }
    if (!manualStop) {
        if (reconnecting) { console.log('[BOT] Already reconnecting due to error, ignoring new error event.'); return; }
        reconnecting = true;
        console.log('[BOT] Attempting to reconnect in 5 seconds due to error...');
        setTimeout(() => {
            createBot();
            reconnecting = false;
        }, 5000);
    }
    sendOrEditStatusEmbed();
  });

  bot.on('end', () => {
    console.warn('[BOT] Minecraft bot disconnected.');
    if (expectedDisconnect) {
        console.log('[BOT] Expected disconnect due to server transfer. Not attempting immediate reconnect.');
        expectedDisconnect = false; 
        reconnecting = false;
        return;
    }
    if (!manualStop) {
        if (reconnecting) { console.log('[BOT] Already reconnecting due to disconnect, ignoring new end event.'); return; }
        reconnecting = true;
        console.log('[BOT] Attempting to reconnect in 5 seconds due to disconnect...');
        setTimeout(() => {
            createBot();
            reconnecting = false;
        }, 5000);
    }
    sendOrEditStatusEmbed();
  });
}

discordClient = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
    partials: [],
});

const commands = [
    new SlashCommandBuilder()
        .setName('status')
        .setDescription('Checks the bot\'s Minecraft and system status (Owner Only).'),
    new SlashCommandBuilder()
        .setName('stats')
        .setDescription('Get bot statistics.')
        .addSubcommand(subcommand =>
            subcommand
                .setName('info')
                .setDescription('Shows the bot\'s money and gem balance.')
        ),
    new SlashCommandBuilder()
        .setName('say')
        .setDescription('Makes the Minecraft bot say a message and waits for a response (Owner Only).')
        .addStringOption(option =>
            option.setName('message')
                .setDescription('The message for the bot to say in Minecraft chat.')
                .setRequired(true)
        ),
];

discordClient.once(Events.ClientReady, async c => {
    console.log(`[DISCORD] Discord Ready! Logged in as ${c.user.tag}`);
    const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
    try {
        console.log('[DISCORD] Started refreshing application (/) commands.');
        await rest.put(
            Routes.applicationGuildCommands(c.user.id, DISCORD_GUILD_ID),
            { body: commands.map(command => command.toJSON()) },
        );
        console.log('[DISCORD] Successfully reloaded application (/) commands.');
        sendOrEditStatusEmbed(); 
    } catch (error) {
        console.error(`[DISCORD] Failed to reload application (/) commands: ${error.message}`);
    }
    createBot(); 
});

discordClient.on(Events.InteractionCreate, async interaction => {
    if (!interaction.isCommand()) return;

    try {
        const { commandName } = interaction;

        if (commandName === 'status') {
            console.log(`[DISCORD_CMD] /status command received from ${interaction.user.tag}.`);
            if (interaction.user.id !== DISCORD_OWNER_ID) {
                return interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });
            }
            await interaction.deferReply({ ephemeral: true });
            await sendOrEditStatusEmbed();
            const replyMessage = USE_DMS_FOR_OWNER ? 'Status has been updated in your DMs.' : 'Status updated. Check the status channel.';
            await interaction.editReply({ content: replyMessage, ephemeral: true });

        } else if (commandName === 'stats') {
            const subCommand = interaction.options.getSubcommand();
            console.log(`[DISCORD_CMD] /stats ${subCommand} command received from ${interaction.user.tag}.`);
            if (subCommand === 'info') {
                await interaction.deferReply();

                if (!bot || !bot.player || !bot.tasksInitialized) {
                    return interaction.editReply({ content: 'Bot is not online or not fully initialized in Minecraft. Please try again in a moment.' });
                }

                const [moneyResult, gemResult] = await Promise.allSettled([
                    requestMoneyBalanceOnce(),
                    requestGemBalanceOnce()
                ]);

                const fetchedMoney = moneyResult.status === 'fulfilled' ? moneyResult.value : botMoneyBalance;
                const fetchedGems = gemResult.status === 'fulfilled' ? gemResult.value : botGemBalance;

                if (moneyResult.status === 'rejected') console.error(`[DISCORD_CMD] Money balance request failed: ${moneyResult.reason}`);
                if (gemResult.status === 'rejected') console.error(`[DISCORD_CMD] Gem balance request failed: ${gemResult.reason}`);

                const statsEmbed = new EmbedBuilder()
                    .setColor('#0099ff')
                    .setTitle('Bot Balances')
                    .setDescription(`**Money Balance:** ${formatNumberShort(fetchedMoney)}\n**Gem Balance:** ${formatNumberShort(fetchedGems)}`)
                    .setTimestamp()
                    .setFooter({ text: 'Bot | IGN: daimyh' });

                await interaction.editReply({ embeds: [statsEmbed] });
            }
        } else if (commandName === 'say') {
            console.log(`[DISCORD_CMD] /say command received from ${interaction.user.tag}.`);
            if (interaction.user.id !== DISCORD_OWNER_ID) {
                return interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });
            }

            if (!bot || !bot.player) {
                return interaction.reply({ content: 'Minecraft bot is not online to send messages.', ephemeral: true });
            }

            if (pendingSayInteraction) {
                return interaction.reply({ content: 'Another /say command is already awaiting a Minecraft response. Please wait.', ephemeral: true });
            }

            await interaction.deferReply({ ephemeral: true });
            pendingSayInteraction = interaction; 

            const message = interaction.options.getString('message');
            bot.chat(message);
            console.log(`[BOT] Bot said: "${message}" in Minecraft. Waiting for response or timeout...`);

            setTimeout(() => {
                if (pendingSayInteraction && pendingSayInteraction.id === interaction.id) {
                    console.log('[DISCORD_CMD] /say command timed out.');
                    const timeoutEmbed = new EmbedBuilder()
                        .setColor('#E67E22')
                        .setTitle('Command Timed Out')
                        .setDescription(`The bot sent \`${message}\` to Minecraft, but no specific "TrySmp" response was received within 5 seconds.`)
                        .setTimestamp();
                    
                    if (USE_DMS_FOR_OWNER) {
                        interaction.user.send({ embeds: [timeoutEmbed] }).catch(err => console.error(`[DISCORD] Failed to send /say timeout notice to DM: ${err.message}`));
                        interaction.editReply({ content: 'Command sent, but no response was received in time. Check your DMs.' });
                    } else {
                        interaction.editReply({ embeds: [timeoutEmbed], ephemeral: false });
                    }
                    pendingSayInteraction = null;
                }
            }, 5000);
        }
    } catch (error) {
        console.error(`[DISCORD_FATAL] An error occurred during interaction handling:`, error);
        if (interaction.deferred || interaction.replied) {
            await interaction.editReply({ content: 'An unexpected error occurred while processing your command.', ephemeral: true }).catch(e => {});
        } else {
            await interaction.reply({ content: 'An unexpected error occurred while processing your command.', ephemeral: true }).catch(e => {});
        }
    }
});

discordClient.login(DISCORD_TOKEN).catch(err => {
  console.error(`[DISCORD_FATAL] Login failed: ${err.message}.`);
});

const gracefulShutdown = (signal) => {
  console.log(`[PROCESS] Received ${signal}. Shutting down...`);
  manualStop = true;
  if (bot) {
    console.log('[BOT] Quitting Minecraft bot...');
    if (bot.balanceUpdateInterval) clearInterval(bot.balanceUpdateInterval);
    if(bot.tasksInitialized) bot.tasksInitialized = false;
    stopAntiAFK();
    bot.quit(`Bot shutting down: ${signal}.`);
  }
  if (discordClient) {
    console.log('[DISCORD] Destroying client...');
    discordClient.destroy();
  }
  setTimeout(() => {
    console.log('[PROCESS] Forcing exit.');
    process.exit(0);
  }, 5000); 
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('uncaughtException', (error) => {
  console.error('[FATAL_ERROR] UNCAUGHT EXCEPTION:', error);
  gracefulShutdown('uncaughtException');
});
