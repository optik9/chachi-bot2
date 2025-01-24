const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const admin = require('firebase-admin');
const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');

// Configuración del cliente
const client = new Client({
    authStrategy: new LocalAuth({
        dataPath: '/tmp/.wwebjs_auth', // Usar /tmp para almacenar la sesión
    }),
    puppeteer: {
        headless: true, // Usar modo headless
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
            '--disable-gpu'
        ],
        executablePath: await chromium.executablePath(), // Usar Chromium optimizado
        timeout: 60000,
    }
});

// Inicializar Firebase
const serviceAccount = require('./serviceAccountKey.json');
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
console.log('Firebase inicializado correctamente');

// Estados del sistema
const STATES = {
    INITIAL: 'INITIAL',
    AWAITING_CLIENT_NAME: 'AWAITING_CLIENT_NAME',
    AWAITING_DESCRIPTION: 'AWAITING_DESCRIPTION',
    AWAITING_UNIT_TYPE: 'AWAITING_UNIT_TYPE',
    AWAITING_QUANTITY: 'AWAITING_QUANTITY',
    AWAITING_PRICE: 'AWAITING_PRICE',
    AWAITING_PRODUCT_ACTION: 'AWAITING_PRODUCT_ACTION',
    EDITING_CART: 'EDITING_CART',
    AWAITING_PAYMENT_METHOD: 'AWAITING_PAYMENT_METHOD',
    CONFIRMING: 'CONFIRMING',
    AWAITING_EMAIL: 'AWAITING_EMAIL' // Nuevo estado para solicitar el email
};

const PAYMENT_METHODS = {
    CASH: 'Efectivo',
    CARD: 'Tarjeta',
    TRANSFER: 'Transferencia',
    YAPE: 'Yape',
    PLIN: 'Plin'
};

const UNIT_TYPES = {
    1: 'Unidades',
    2: 'Kilos',
    3: 'Gramos',
    4: 'Litros'
};

// Mapas para almacenar estados y datos temporales
const userStates = new Map();
const tempSales = new Map();

// Función para mostrar el carrito actual
function formatCart(cart) {
    if (!cart || cart.length === 0) return 'Carrito vacío';

    let total = 0;
    let cartText = '🛒 *Carrito Actual*\n\n';

    cart.forEach((item, index) => {
        const subtotal = item.quantity * item.price;
        total += subtotal;
        cartText += `${index + 1}. ${item.description}\n` +
                   `   Cantidad: ${item.quantity} ${item.unitType}\n` +
                   `   Precio: S/.${item.price}\n` +
                   `   Subtotal: S/.${subtotal}\n\n`;
    });

    cartText += `\n*Total: S/.${total.toFixed(2)}*`;
    return cartText;
}

// Función para guardar la venta en Firebase
async function saveSale(number, saleData) {
    console.log(`Guardando venta para usuario ${number}`);
    try {
        const sale = {
            ...saleData,
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
            userId: number,
            status: 'completed'
        };

        const docRef = await db.collection('sales').add(sale);
        console.log(`Venta guardada con ID: ${docRef.id}`);
        return docRef.id;
    } catch (error) {
        console.error('Error al guardar venta:', error);
        throw error;
    }
}

// Función para verificar usuario autorizado con logs
async function isAuthorizedUser(number) {
    console.log(`Verificando autorización para usuario ${number}`);
    try {
        const userDoc = await db.collection('authorized_users').doc(number).get();
        console.log(`Usuario ${number} autorizado: ${userDoc.exists}`);
        return userDoc.exists;
    } catch (error) {
        console.error('Error al verificar autorización:', error);
        return false;
    }
}

// Función para registrar nuevo usuario con logs
async function registerAuthorizedUser(number, businessName, email) {
    console.log(`Registrando nuevo negocio: ${businessName} para número ${number} con email ${email}`);
    try {
        await db.collection('authorized_users').doc(number).set({
            businessName: businessName,
            email: email,
            registeredAt: admin.firestore.FieldValue.serverTimestamp()
        });
        console.log('Usuario registrado exitosamente');
        return true;
    } catch (error) {
        console.error('Error al registrar usuario:', error);
        throw error;
    }
}

// Función para inicializar una nueva venta
function initializeNewSale() {
    return {
        clientName: '',
        products: [],
        paymentMethod: '',
        total: 0
    };
}

// Manejador principal de mensajes
client.on('message', async msg => {
    try {
        const userNumber = msg.from.split('@')[0];
        const messageContent = msg.body.toLowerCase();

        console.log(`\nMensaje recibido de ${userNumber}: ${messageContent}`);

        // Verificar si el usuario está autenticado antes de continuar
        const isAuthorized = await isAuthorizedUser(userNumber);
        if (!isAuthorized) {
            let currentState = userStates.get(userNumber) || STATES.INITIAL;

            if (currentState === STATES.INITIAL && messageContent.startsWith('registrar')) {
                const args = messageContent.split(' ');
                if (args.length < 2) {
                    await msg.reply('Por favor, incluya el nombre de su negocio al registrar. Ejemplo: "registrar MiNegocio".');
                    return;
                }
                const businessName = args.slice(1).join(' ');
                userStates.set(userNumber, STATES.AWAITING_EMAIL);
                tempSales.set(userNumber, { businessName });
                await msg.reply('Por favor, proporcione un correo electrónico para su registro:');
            } else if (currentState === STATES.AWAITING_EMAIL) {
                const userData = tempSales.get(userNumber);
                if (!userData) {
                    await msg.reply('Ocurrió un error. Por favor, intente registrarse nuevamente.');
                    userStates.delete(userNumber);
                    tempSales.delete(userNumber);
                    return;
                }

                // Validación simple del email
                const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
                if (!emailRegex.test(msg.body)) {
                    await msg.reply('Por favor, proporcione un correo electrónico válido.');
                    return;
                }

                userData.email = msg.body;
                try {
                    await registerAuthorizedUser(userNumber, userData.businessName, userData.email);
                    await msg.reply(`¡Registro exitoso! Ahora puede iniciar ventas escribiendo "nueva venta".`);
                } catch (error) {
                    await msg.reply('Hubo un problema al registrar su negocio. Por favor, intente nuevamente.');
                }

                userStates.delete(userNumber);
                tempSales.delete(userNumber);
            } else {
                await msg.reply(
                    '¡Bienvenido al sistema de ventas!\n\n' +
                    'Parece que no está registrado. Para registrarse, escriba "registrar [NombreNegocio]".'
                );
            }
            return;
        }

        let currentState = userStates.get(userNumber) || STATES.INITIAL;
        let currentSale = tempSales.get(userNumber);

        if (!currentSale && currentState !== STATES.INITIAL) {
            currentSale = initializeNewSale();
            tempSales.set(userNumber, currentSale);
        }

        console.log(`Estado actual: ${currentState}`);

        switch (currentState) {
            case STATES.INITIAL:
                if (messageContent === 'nueva venta') {
                    // Limpiar cualquier dato previo
                    userStates.set(userNumber, STATES.AWAITING_CLIENT_NAME);
                    // Inicializar una nueva venta limpia
                    tempSales.set(userNumber, initializeNewSale());
                    await msg.reply('Por favor, ingrese el nombre del cliente:');
                } else {
                    await msg.reply(
                        '¡Bienvenido al sistema de ventas!\n\n' +
                        'Escriba "nueva venta" para comenzar.'
                    );
                }
                break;

            case STATES.AWAITING_CLIENT_NAME:
                currentSale.clientName = msg.body;
                userStates.set(userNumber, STATES.AWAITING_DESCRIPTION);
                await msg.reply('Ingrese la descripción del producto:');
                break;

            case STATES.AWAITING_DESCRIPTION:
                currentSale.tempProduct = {
                    description: msg.body,
                    quantity: 0,
                    price: 0,
                    unitType: ''
                };
                userStates.set(userNumber, STATES.AWAITING_UNIT_TYPE);
                await msg.reply(
                    '¿Qué tipo de unidad usará?\n' +
                    '1. Unidades\n' +
                    '2. Kilos\n' +
                    '3. Gramos\n' +
                    '4. Litros\n\n' +
                    'Escriba el número de la opción que desea.'
                );
                break;

            case STATES.AWAITING_UNIT_TYPE:
                const unitType = UNIT_TYPES[messageContent];
                if (!unitType) {
                    await msg.reply('Por favor, seleccione un tipo de unidad válido.');
                    return;
                }
                currentSale.tempProduct.unitType = unitType;
                userStates.set(userNumber, STATES.AWAITING_QUANTITY);
                await msg.reply(`Ingrese la cantidad en ${unitType}:`);
                break;

            case STATES.AWAITING_QUANTITY:
                if (isNaN(messageContent)) {
                    await msg.reply('Por favor, ingrese un número válido para la cantidad.');
                    return;
                }
                currentSale.tempProduct.quantity = parseFloat(messageContent);
                userStates.set(userNumber, STATES.AWAITING_PRICE);
                await msg.reply('Ingrese el precio por unidad:');
                break;

            case STATES.AWAITING_PRICE:
                if (isNaN(messageContent)) {
                    await msg.reply('Por favor, ingrese un número válido para el precio.');
                    return;
                }
                currentSale.tempProduct.price = parseFloat(messageContent);
                currentSale.products.push({ ...currentSale.tempProduct });
                delete currentSale.tempProduct;

                await msg.reply(
                    `${formatCart(currentSale.products)}\n\n` +
                    '¿Qué desea hacer?\n' +
                    '1. Agregar producto\n' +
                    '2. Eliminar producto\n' +
                    '3. Finalizar venta'
                );
                userStates.set(userNumber, STATES.AWAITING_PRODUCT_ACTION);
                break;

            case STATES.AWAITING_PRODUCT_ACTION:
                switch (messageContent) {
                    case '1':
                        userStates.set(userNumber, STATES.AWAITING_DESCRIPTION);
                        await msg.reply('Ingrese la descripción del nuevo producto:');
                        break;
                    case '2':
                        if (currentSale.products.length === 0) {
                            await msg.reply('No hay productos para eliminar.');
                            return;
                        }
                        const productList = currentSale.products.map((p, i) =>
                            `${i + 1}. ${p.description} (${p.quantity} ${p.unitType})`
                        ).join('\n');
                        await msg.reply(`Ingrese el número del producto a eliminar:\n\n${productList}`);
                        userStates.set(userNumber, STATES.EDITING_CART);
                        break;
                    case '3':
                        userStates.set(userNumber, STATES.AWAITING_PAYMENT_METHOD);
                        await msg.reply(
                            '¿Qué método de pago usará el cliente?\n' +
                            '1. Efectivo\n' +
                            '2. Tarjeta\n' +
                            '3. Transferencia\n' +
                            '4. Yape\n' +
                            '5. Plin'
                        );
                        break;
                    default:
                        await msg.reply('Por favor, seleccione una opción válida.');
                        break;
                }
                break;

            case STATES.EDITING_CART:
                const indexToDelete = parseInt(messageContent) - 1; // Convertir el número ingresado a índice (basado en 0)

                if (isNaN(indexToDelete) || indexToDelete < 0 || indexToDelete >= currentSale.products.length) {
                    await msg.reply('Por favor, ingrese un número válido que corresponda a un producto en el carrito.');
                    return;
                }

                // Eliminar el producto del carrito
                const removedProduct = currentSale.products.splice(indexToDelete, 1);

                await msg.reply(
                    `Producto eliminado: ${removedProduct[0].description}\n\n` +
                    `${formatCart(currentSale.products)}\n\n` +
                    '¿Qué desea hacer?\n' +
                    '1. Agregar producto\n' +
                    '2. Eliminar producto\n' +
                    '3. Finalizar venta'
                );

                userStates.set(userNumber, STATES.AWAITING_PRODUCT_ACTION); // Regresar al menú de acciones
                break;

            case STATES.AWAITING_PAYMENT_METHOD:
                const paymentMethod = Object.values(PAYMENT_METHODS)[parseInt(messageContent) - 1];
                if (!paymentMethod) {
                    await msg.reply('Por favor, seleccione un método de pago válido.');
                    return;
                }
                currentSale.paymentMethod = paymentMethod;
                currentSale.total = currentSale.products.reduce((total, product) =>
                    total + (product.quantity * product.price), 0);
                userStates.set(userNumber, STATES.CONFIRMING);
                await msg.reply(
                    `${formatCart(currentSale.products)}\n\n` +
                    `Método de pago: ${paymentMethod}\n\n` +
                    '*¿Desea confirmar la venta?*\nEscriba "sí" para confirmar o "no" para cancelar.'
                );
                break;

            case STATES.CONFIRMING:
                if (messageContent === 'si' || messageContent === 'sí') {
                    try {
                        await saveSale(userNumber, currentSale);
                        await msg.reply('¡Venta registrada exitosamente!');
                    } catch (error) {
                        await msg.reply('Ocurrió un error al registrar la venta. Por favor, intente nuevamente.');
                    }
                    // Limpiar los datos temporales y el estado del usuario
                    userStates.delete(userNumber);
                    tempSales.delete(userNumber);
                } else if (messageContent === 'no') {
                    // Limpiar los datos temporales y el estado del usuario
                    userStates.delete(userNumber);
                    tempSales.delete(userNumber);
                    await msg.reply('Venta cancelada.');
                } else {
                    await msg.reply('Por favor, escriba "sí" o "si" para confirmar o "no" para cancelar.');
                }
                break;

            default:
                await msg.reply('Ocurrió un error. Por favor, intente nuevamente.');
                userStates.delete(userNumber);
                tempSales.delete(userNumber);
                break;
        }

    } catch (error) {
        console.error('Error en el procesamiento del mensaje:', error);
        await msg.reply('Ocurrió un error. Por favor, intente nuevamente.');
        userStates.delete(userNumber);
        tempSales.delete(userNumber); // LIMPIAR DATOS TEMPORALES
    }
});

// Generar QR y escuchar eventos
client.on('qr', qr => {
    qrcode.generate(qr, { small: true });
    console.log('QR generado, escanea para iniciar sesión.');
});

client.on('ready', () => {
    console.log('Cliente de WhatsApp conectado y listo.');
});

client.initialize();