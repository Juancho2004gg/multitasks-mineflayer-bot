const mineflayer = require('mineflayer');
const pathfinder = require('mineflayer-pathfinder').pathfinder;
const Movements = require('mineflayer-pathfinder').Movements;
const { GoalNear, GoalBlock, GoalFollow } = require('mineflayer-pathfinder').goals;
const collectBlock = require('mineflayer-collectblock').plugin;
const Vec3 = require('vec3'); // Add this import

const bot = mineflayer.createBot({
  host: 'localhost',
  port: 25568,
  username: 'MinerBot',
  version: '1.21.6'
});

// Load plugins
bot.loadPlugin(pathfinder);
bot.loadPlugin(collectBlock);

// Bot state
let mcData 
let nowFishing = false; 
let shouldKeepFishing = false;
let mining = false;
let following = false;
let followTarget = null;
let currentChunk = null;
let miningQueue = [];
let homeChest = null;
let bedCoords = null;
let lastDimension = 'overworld';
let lastFoodWarning = 0; // Timestamp for food warning cooldown

bot.once('spawn', () => {
  console.log('Multi-Function Bot spawned!');
  mcData = require('minecraft-data')(bot.version); 

  // Set up movement defaults
  const movements = new Movements(bot);
  movements.canDig = true;
  movements.scafoldingBlocks = [];
  movements.allowParkour = true;
  movements.allowSprinting = true;
  bot.pathfinder.setMovements(movements);
  
  console.log('Commands:');
  console.log('- "mine chunk" - Start mining the current chunk');
  console.log('- "stop mining" - Stop mining');
  console.log('- "follow me" - Start following you');
  console.log('- "follow [player]" - Follow specific player');
  console.log('- "stop following" - Stop following');
  console.log('- "come here" - Come to your position');
  console.log('- "set chest" - Set nearby chest as storage');
  console.log('- "status" - Show bot status');
  console.log('- "tools" - Show detailed tool status');
  console.log('- "sleep" - Find and sleep in a bed');
  console.log('- "eat" - Eat food to restore hunger');
  console.log('- "save" - Save items into home chest');
  console.log('- "find [minecraft:block]" - Find and collect items based on which one I say');
});

// Detect dimension changes
bot.on('respawn', () => {
  console.log('Bot respawned - checking dimension...');
  setTimeout(() => {
    detectDimension();
  }, 1000);
});

function detectDimension() {
  const y = bot.entity.position.y;
  const blockBelow = bot.blockAt(bot.entity.position.offset(0, -1, 0));
  
  if (y < 0 || (blockBelow && blockBelow.name === 'bedrock')) {
    if (lastDimension !== 'nether') {
      lastDimension = 'nether';
      bot.chat('Entered the Nether!');
      console.log('Bot is now in the Nether');
    }
  } else {
    if (lastDimension !== 'overworld') {
      lastDimension = 'overworld';
      bot.chat('Returned to Overworld!');
      console.log('Bot is now in the Overworld');
    }
  }
}

bot.on('chat', async (username, message) => {
  if (username === bot.username) return;
  
  const command = message.toLowerCase().trim();
  const args = message.split(' ');
  
  try {
    switch (command) {
      // Add this as a separate command to test just looking
      case 'look east':
        bot.pathfinder.setGoal(null);
        await sleep(100);
        await bot.look(-Math.PI / 2, -0.3);
        bot.chat('Should be looking east now');
        break;
      case 'mine chunk':
        await startChunkMining();
        break;
      case 'stop mining':
        stopMining();
        break;
      case 'follow me':
        startFollowing("jgalicia");
        break;
      case 'stop following':
        stopFollowing();
        break;
      case 'come here':
        await comeToPlayer(username);
        break;
      case 'set chest':
        setHomeChest();
        break;
      case 'status':
        showStatus();
        break;
      case 'tools':
        showDetailedStatus();
        break;
      case 'sleep':
        await findAndSleep();
        break;
      case 'eat':
        await eatFood();
        break;
      case 'drop':
        await comeToPlayer(username);
        await dropAll();
        break;
      case 'save':
        await saveItems();
        break;
      case 'fish':
        await startFishing();
        break;
      case 'stop fishing':
        await stopFishing();
        break;
    }
    
    // Handle "follow [player]" command
    if (args[0] === 'follow' && args[1]) {
      startFollowing(args[1]);
    }

    if (args[0] === 'find' && args[1]) {
    await findNearbyItems(args[1]);
    return; // Add return to prevent other commands from running
  }
    
  } catch (error) {
    bot.chat(`Error: ${error.message}`);
    console.error(error);
  }
});

// Portal detection and following logic
bot.on('physicsTick', async () => {
  // Check if bot is in a portal
  const block = bot.blockAt(bot.entity.position);
  if (block && block.name === 'nether_portal') {
    console.log('Bot is in nether portal...');
    
    // If following someone, wait a moment then continue following
    if (following && followTarget) {
      setTimeout(() => {
        const player = bot.players[followTarget];
        if (player && player.entity) {
          console.log(`Resuming following ${followTarget} after portal`);
          bot.pathfinder.setGoal(new GoalFollow(player.entity, 3));
        }
      }, 3000); // Wait 3 seconds for portal transition
    }
  }
  
  // Update following
  if (following && followTarget) {
    await updateFollowing();
  }
});

async function startFollowing(playerName) {
  const player = bot.players[playerName];
  if (!player) {
    bot.chat(`Player ${playerName} not found!`);
    return;
  }
  
  // Stop mining if active
  if (mining) {
    stopMining();
  }
  
  following = true;
  followTarget = playerName;
  bot.chat(`Following ${playerName}!`);
  console.log(`Started following ${playerName}`);
  
  // Start following immediately
  await updateFollowing();
}

async function updateFollowing() {
  if (!following || !followTarget) return;
  
  const player = bot.players[followTarget];
  if (!player || !player.entity) {
    console.log(`Lost track of ${followTarget}`);
    return;
  }
  
  const distance = bot.entity.position.distanceTo(player.entity.position);
  
  // Check if player went through a portal (sudden distance change)
  if (distance > 1000) {
    console.log(`${followTarget} likely went through a portal, searching for portals...`);
    await followThroughPortal();
    return;
  }
  
  // Normal following logic
  if (distance > 5) {
    const goal = new GoalFollow(player.entity, 3);
    bot.pathfinder.setGoal(goal);
  } else if (distance < 2) {
    // Stop if too close
    bot.pathfinder.setGoal(null);
  }
}

async function followThroughPortal() {
  try {
    // Look for nearby nether portals
    const portal = bot.findBlock({
      matching: (block) => block.name === 'nether_portal',
      maxDistance: 20
    });
    
    if (portal) {
      console.log('Found portal, entering...');
      bot.chat('Following through portal...');
      
      // Go to portal
      const goal = new GoalBlock(portal.position.x, portal.position.y, portal.position.z);
      await bot.pathfinder.goto(goal);
      
      // Walk into the portal
      await sleep(2000);
      
      // Wait for dimension change
      setTimeout(() => {
        if (following && followTarget) {
          const player = bot.players[followTarget];
          if (player && player.entity) {
            console.log('Portal crossed, resuming following');
            bot.pathfinder.setGoal(new GoalFollow(player.entity, 3));
          }
        }
      }, 5000);
      
    } else {
      console.log('No portal found nearby');
      bot.chat(`Lost ${followTarget} - no portal found nearby`);
    }
  } catch (error) {
    console.error('Error following through portal:', error);
    bot.chat('Had trouble following through portal');
  }
}

async function comeToPlayer(playerName) {
  const player = bot.players[playerName];
  if (!player || !player.entity) {
    bot.chat(`Player ${playerName} not found!`);
    return;
  }
  
  // Stop current activities
  if (mining) stopMining();
  if (following) stopFollowing();
  
  bot.chat(`Coming to ${playerName}!`);
  
  try {
    const goal = new GoalNear(
      player.entity.position.x,
      player.entity.position.y,
      player.entity.position.z,
      2
    );
    
    await bot.pathfinder.goto(goal);
    bot.chat(`I'm here!`);
  } catch (error) {
    bot.chat(`Couldn't reach ${playerName}: ${error.message}`);
  }
}

function stopFollowing() {
  following = false;
  followTarget = null;
  bot.pathfinder.setGoal(null);
  bot.chat('Stopped following');
}

async function startChunkMining() {
  if (mining) {
    bot.chat('Already mining!');
    return;
  }
  
  mining = true;
  currentChunk = getChunkCoords(bot.entity.position);
  bot.chat(`Starting to mine chunk ${currentChunk.x}, ${currentChunk.z}`);
  
  // Generate mining pattern for the chunk (16x16 area)
  miningQueue = generateMiningPattern(currentChunk);
  
  console.log(`Generated ${miningQueue.length} mining positions`);
  await processMiningQueue();
}

function stopMining() {
  mining = false;
  miningQueue = [];
  bot.chat('Mining stopped');
}

function getChunkCoords(position) {
  return {
    x: Math.floor(position.x / 16),
    z: Math.floor(position.z / 16)
  };
}

function generateMiningPattern(chunk) {
  const pattern = [];
  const startX = chunk.x * 16;
  const startZ = chunk.z * 16;
  
  // Mine from bedrock level up to y=60 (adjust as needed)
  for (let y = -57; y <= -30; y++) {
    // Strip mining pattern - mine every 3rd layer to maximize efficiency
    if (y % 3 === 0) {
      for (let x = startX; x < startX + 16; x++) {
        for (let z = startZ; z < startZ + 16; z++) {
          pattern.push({ x, y, z });
        }
      }
    }
  }
  
  return pattern;
}

async function processMiningQueue() {
  while (mining && miningQueue.length > 0) {
    const target = miningQueue.shift();
    await minePosition(target);
    
    // Auto-eat if hunger is low (with spam prevention)
    if (bot.food <= 6) {
      const now = Date.now();
      // Only try to eat every 30 seconds if no food available
      if (now - lastFoodWarning > 30000) {
        console.log('Hunger low, attempting to eat...');
        const ateSuccessfully = await eatFood();
        if (!ateSuccessfully) {
          lastFoodWarning = now; // Set cooldown only if eating failed
        }
      }
    }
    
    // Check inventory and deposit items if needed
    if (isInventoryFull()) {
      await depositItems();
    }
    
    // Small delay to prevent overwhelming the server
    await sleep(500);
  }
  
  if (mining) {
    bot.chat('Chunk mining completed!');
    mining = false;
  }
}

async function minePosition(target) {
  try {
    // Fix: Use new Vec3() constructor instead of bot.vec3()
    const block = bot.blockAt(new Vec3(target.x, target.y, target.z));
    
    if (!block || block.name === 'air' || block.name === 'bedrock') {
      return;
    }
    
    // Skip blocks that aren't worth mining (dirt, stone, etc.) - customize as needed
    const valuableBlocks = [
      'coal_ore', 'iron_ore', 'gold_ore', 'diamond_ore', 'emerald_ore',
      'redstone_ore', 'lapis_ore', 'copper_ore', 'deepslate_coal_ore',
      'deepslate_iron_ore', 'deepslate_gold_ore', 'deepslate_diamond_ore',
      'deepslate_emerald_ore', 'deepslate_redstone_ore', 'deepslate_lapis_ore',
      'deepslate_copper_ore', 'ancient_debris', 'stone', 'cobblestone',
      'granite', 'diorite', 'andesite', 'deepslate'
    ];
    
    // Mine valuable blocks or all blocks if you want to clear the chunk completely
    if (valuableBlocks.includes(block.name) || shouldMineAllBlocks()) {
      // Check if we have the right tool and durability
      const toolCheck = await checkAndEquipTool(block);
      if (!toolCheck.success) {
        console.log(`Skipping ${block.name}: ${toolCheck.reason}`);
        return;
      }
      
      console.log(`Mining ${block.name} at ${target.x}, ${target.y}, ${target.z} with ${toolCheck.tool.name}`);
      await bot.collectBlock.collect(block);
    }
    
  } catch (error) {
    console.error(`Failed to mine position ${target.x}, ${target.y}, ${target.z}:`, error.message);
  }
}

async function checkAndEquipTool(block) {
  // Define tool requirements for different blocks
  const blockToolRequirements = {
    // Stone-tier blocks (need at least wooden pickaxe)
    'stone': ['pickaxe', 'wooden'],
    'cobblestone': ['pickaxe', 'wooden'],
    'granite': ['pickaxe', 'wooden'],
    'diorite': ['pickaxe', 'wooden'],
    'andesite': ['pickaxe', 'wooden'],
    'coal_ore': ['pickaxe', 'wooden'],
    'deepslate_coal_ore': ['pickaxe', 'wooden'],
    'deepslate': ['pickaxe', 'wooden'],
    
    // Iron-tier blocks (need at least stone pickaxe)
    'iron_ore': ['pickaxe', 'stone'],
    'deepslate_iron_ore': ['pickaxe', 'stone'],
    'copper_ore': ['pickaxe', 'stone'],
    'deepslate_copper_ore': ['pickaxe', 'stone'],
    'lapis_ore': ['pickaxe', 'stone'],
    'deepslate_lapis_ore': ['pickaxe', 'stone'],
    
    // Diamond-tier blocks (need at least iron pickaxe)
    'gold_ore': ['pickaxe', 'iron'],
    'deepslate_gold_ore': ['pickaxe', 'iron'],
    'redstone_ore': ['pickaxe', 'iron'],
    'deepslate_redstone_ore': ['pickaxe', 'iron'],
    'diamond_ore': ['pickaxe', 'iron'],
    'deepslate_diamond_ore': ['pickaxe', 'iron'],
    'emerald_ore': ['pickaxe', 'iron'],
    'deepslate_emerald_ore': ['pickaxe', 'iron'],
    
    // Netherite-tier blocks (need diamond pickaxe)
    'ancient_debris': ['pickaxe', 'diamond']
  };
  
  const requirement = blockToolRequirements[block.name];
  if (!requirement) {
    return { success: true, tool: null }; // No specific tool required
  }
  
  const [toolType, minTier] = requirement;
  
  // Get tool tier hierarchy
  const tierHierarchy = ['wooden', 'stone', 'iron', 'diamond', 'netherite'];
  const minTierIndex = tierHierarchy.indexOf(minTier);
  
  // Find the best available tool
  let bestTool = null;
  let bestTierIndex = -1;
  

  for (const item of bot.inventory.items()) {
    if (item.name.includes(toolType)) {
      // Check durability (skip if too low)
      const maxDurability = getMaxDurability(item.name);
      const currentDurability = maxDurability - (item.nbt?.value?.Damage?.value || 0);
      
      if (currentDurability <= 5) { // Don't use tools with 5 or less durability
        continue;
      }
      
      // Check tier
      for (let i = tierHierarchy.length - 1; i >= minTierIndex; i--) {
        if (item.name.includes(tierHierarchy[i])) {
          if (i > bestTierIndex) {
            bestTool = item;
            bestTierIndex = i;
          }
          break;
        }
      }
    }
  }
  
  if (!bestTool) {
    return {
      success: false,
      reason: `No suitable ${toolType} found (need at least ${minTier} tier)`
    };
  }
  
  // Equip the tool if it's not already equipped
  try {
    await bot.equip(bestTool, 'hand');
    return {
      success: true,
      tool: bestTool,
      durability: getMaxDurability(bestTool.name) - (bestTool.nbt?.value?.Damage?.value || 0)
    };
  } catch (error) {
    return {
      success: false,
      reason: `Failed to equip ${bestTool.name}: ${error.message}`
    };
  }
}

function getMaxDurability(itemName) {
  const durabilities = {
    // Pickaxes
    'wooden_pickaxe': 59,
    'stone_pickaxe': 131,
    'iron_pickaxe': 250,
    'diamond_pickaxe': 1561,
    'netherite_pickaxe': 2031,
    
    // Shovels
    'wooden_shovel': 59,
    'stone_shovel': 131,
    'iron_shovel': 250,
    'diamond_shovel': 1561,
    'netherite_shovel': 2031,
    
    // Axes
    'wooden_axe': 59,
    'stone_axe': 131,
    'iron_axe': 250,
    'diamond_axe': 1561,
    'netherite_axe': 2031,
  };
  
  return durabilities[itemName] || 100; // Default fallback
}

function isNightTime() {
    return bot.time.timeOfDay > 13000 && bot.time.timeOfDay < 23000
}
async function findAndSleep() {

    // Stop current activities
  if(nowFishing || shouldKeepFishing){
    bot.chat('Stopping fishing to sleep');
    stopFishing();
  }
  if (mining) {
    bot.chat('Stopping mining to sleep...');
    stopMining();
  }
  if (following) {
    bot.chat('Stopping following to sleep...');
    stopFollowing();
  }

  if (bedCoords !== null)
    {
    try {
      // Go to bed
      await bot.pathfinder.goto(new GoalNear(bedCoords.position.x, bedCoords.position.y, bedCoords.position.z, 1));
      
    } catch (error) {
      bot.chat(`Failed to reach bed coordinates: ${error.message}`);
    }
  }
  
  const bed = bot.findBlock({
    matching: block => bot.isABed(block),
    maxDistance: 64,
    count: 1
  });

  if (bed) {
    try {
      await bot.sleep(bed);
      bedCoords = bed
      console.log(`Bed set at ${bed.position.x}, ${bed.position.y}, ${bed.position.z}`);
      bot.chat("I'm sleeping 😴");
    } catch (err) {
      bot.chat(`I can't sleep: ${err.message}`);
    }
  } else {
    bot.chat('No nearby bed');
  }
}

async function eatFood() {
  try {
    // Find the best food item to eat
    const foodItems = bot.inventory.items().filter(item => isFoodItem(item));
    
    if (foodItems.length === 0) {
      // Only show this message if it's been a while since last warning
      const now = Date.now();
      if (now - lastFoodWarning > 60000) { // 60 seconds cooldown
        bot.chat('No food available!');
        lastFoodWarning = now;
      }
      return false; // Return false to indicate eating failed
    }
    
    // Sort food by preference (better food first)
    const bestFood = getBestFood(foodItems);
    
    if (!bestFood) {
      bot.chat('No suitable food found!');
      return false;
    }
    
    const currentFood = bot.food;
    bot.chat(`Eating ${bestFood.name} (hunger: ${currentFood}/20)`);
    
    // Equip and eat the food
    await bot.equip(bestFood, 'hand');
    await bot.consume();
    
    const newFood = bot.food;
    console.log(`Ate ${bestFood.name}! Hunger: ${currentFood}/20 -> ${newFood}/20`);
    
    return true; // Return true to indicate eating succeeded
    
  } catch (error) {
    console.log(`Failed to eat: ${error.message}`);
    console.log('Eat error:', error);
    return false;
  }
}

function isFoodItem(item) {
  const foodItems = [
    'bread', 'carrot', 'potato', 'baked_potato', 'beetroot',
    'apple', 'golden_apple', 'enchanted_golden_apple',
    'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton',
    'cooked_rabbit', 'cooked_cod', 'cooked_salmon',
    'beef', 'porkchop', 'chicken', 'mutton', 'rabbit', 'cod', 'salmon',
    'cookie', 'melon_slice', 'sweet_berries', 'honey_bottle',
    'mushroom_stew', 'rabbit_stew', 'beetroot_soup',
    'dried_kelp', 'tropical_fish', 'pufferfish', 'golden_carrot'
  ];
  
  return foodItems.some(food => item.name === food);
}

function getBestFood(foodItems) {
  // Food preference ranking (higher number = better)
  const foodRanking = {
    // Best foods (high hunger restoration, good saturation)
    'golden_apple': 100,
    'enchanted_golden_apple': 99,
    'cooked_beef': 90,
    'cooked_porkchop': 89,
    'cooked_mutton': 85,
    'cooked_chicken': 80,
    'cooked_rabbit': 75,
    'cooked_salmon': 70,
    'cooked_cod': 65,
    'bread': 60,
    'baked_potato': 55,
    
    // Decent foods
    'mushroom_stew': 50,
    'rabbit_stew': 49,
    'beetroot_soup': 48,
    'apple': 40,
    'carrot': 35,
    'potato': 30,
    'beetroot': 25,
    'sweet_berries': 20,
    'dried_kelp': 15,
    'cookie': 10,
    'melon_slice': 5,
    
    // Raw foods (less preferred)
    'beef': -10,
    'porkchop': -9,
    'mutton': -8,
    'chicken': -7,
    'rabbit': -6,
    'salmon': -5,
    'cod': -4,
    'tropical_fish': -15,
    'pufferfish': -20 // Avoid pufferfish (poisonous)
  };
  
  // Sort by ranking (best first)
  foodItems.sort((a, b) => {
    const rankA = foodRanking[a.name] || 0;
    const rankB = foodRanking[b.name] || 0;
    return rankB - rankA;
  });
  
  return foodItems[0];
}

function isInventoryFull() {
  const usedSlots = bot.inventory.items().length;
  return usedSlots >= 32; // Leave some space for tools
}


async function depositItems() {
  if (!homeChest) {
    bot.chat('No chest set! Use "set chest" command near a chest.');
    return;
  }
  
  try {
    // Go to chest
    await bot.pathfinder.goto(new GoalNear(homeChest.position.x, homeChest.position.y, homeChest.position.z, 1));
    
    // Open chest and deposit items
    const chest = await bot.openChest(homeChest);
    
    // Get fresh inventory snapshot
    const itemsToDeposit = bot.inventory.items().filter(item => !isEssentialItem(item));
    
    if (itemsToDeposit.length === 0) {
      bot.chat('No items to deposit');
      chest.close();
      return;
    }

    bot.chat(`Depositing ${itemsToDeposit.length} items...`);
    
    for (const item of itemsToDeposit) {
      try {
        // Double-check item still exists before depositing
        const currentItem = bot.inventory.findInventoryItem(item.type);
        if (currentItem && currentItem.count > 0) {
          await chest.deposit(item.type, null, currentItem.count);
          console.log(`Deposited ${currentItem.count} ${item.name}`);
          
          // Small delay to prevent race conditions
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      } catch (itemError) {
        console.log(`Failed to deposit ${item.name}: ${itemError.message}`);
        // Continue with next item instead of failing completely
      }
    }
    
    chest.close();
    bot.chat('Items deposited!');
    
  } catch (error) {
    bot.chat(`Failed to deposit items: ${error.message}`);
    // Ensure chest is closed even on error
    if (bot.currentWindow) {
      bot.currentWindow.close();
    }
  }
}
// Enhanced save function with better error handling
async function saveItems() {
    try {
        // Find nearby chest
        const chests = bot.findBlocks({
            matching: mcData.blocksByName.chest.id,
            maxDistance: 10,
            count: 1
        });

        if (!chests || chests.length === 0) {
            bot.chat('No chest found nearby');
            return;
        }

        const chestPos = chests[0];
        const chest = bot.blockAt(chestPos);

        // Open the chest
        await bot.openChest(chest);
        console.log('Chest opened, depositing items...');

        // Get all items from bot inventory (excluding hotbar and equipment)
        const itemsToDeposit = bot.inventory.items().filter(item => {
            // Skip items in hotbar (slots 0-8) and equipment slots
            return item.slot >= 9 && item.slot <= 35; // Main inventory slots only
        });

        if (itemsToDeposit.length === 0) {
            bot.chat('No items to deposit');
            bot.closeWindow(bot.currentWindow);
            return;
        }

        bot.chat(`Found ${itemsToDeposit.length} items to deposit`);

        // Deposit items one by one with error handling
        for (const item of itemsToDeposit) {
            try {
                await bot.moveSlotItem(item.slot, bot.currentWindow.firstEmptySlotRange());
                console.log(`Deposited ${item.count} ${item.name}`);
                await new Promise(resolve => setTimeout(resolve, 100)); // Small delay
            } catch (err) {
                if (err.message.includes('No space')) {
                    bot.chat('Chest is full! Cannot deposit more items');
                    break;
                } else {
                    console.log(`Failed to deposit ${item.name}: ${err.message}`);
                    // Continue with next item
                }
            }
        }

        // Close chest
        bot.closeWindow(bot.currentWindow);
        bot.chat('Finished depositing items');

    } catch (err) {
        bot.chat(`Save error: ${err.message}`);
        // Try to close window if it's open
        if (bot.currentWindow) {
            bot.closeWindow(bot.currentWindow);
        }
    }
}

async function dropAll() {
  const items = bot.inventory.items()
  for (let i = 0; i < items.length; i++) {
    await bot.tossStack(items[i])
  }
}

function isEssentialItem(item) {
  const essential = [
    'diamond_pickaxe', 'iron_pickaxe', 'stone_pickaxe', 'wooden_pickaxe',
    'diamond_shovel', 'iron_shovel', 'stone_shovel', 'wooden_shovel',
    'bread', 'cooked_beef', 'cooked_porkchop', 'golden_apple', 'baked_potato', 'fishing_rod'
  ];
  return essential.some(name => item.name.includes(name));
}

function setHomeChest() {
  const chest = bot.findBlock({
    matching: (block) => block.name === 'chest',
    maxDistance: 5
  });
  
  if (chest) {
    homeChest = chest;
    bot.chat(`Chest set at ${chest.position.x}, ${chest.position.y}, ${chest.position.z}`);
  } else {
    bot.chat('No chest found nearby!');
  }
}

function showStatus() {
  let status = [];
  
  if (mining) {
    const remaining = miningQueue.length;
    status.push(`Mining chunk ${currentChunk?.x}, ${currentChunk?.z} - ${remaining} positions left`);
  }
  
  if (following) {
    status.push(`Following ${followTarget}`);
  }
  
  status.push(`Currently in: ${lastDimension}`);
  status.push(`Health: ${bot.health}/20 | Food: ${bot.food}/20`);
  
  if (status.length === 0) {
    status.push('Idle - waiting for commands');
  }
  
  bot.chat(status.join(' | '));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Error handling
bot.on('error', (err) => {
  console.error('Bot error:', err);
});

bot.on('end', () => {
  console.log('Bot disconnected');
  mining = false;
});

// Auto-reconnect (optional)
bot.on('kicked', (reason) => {
  console.log('Kicked:', reason);
  mining = false;
});


async function findNearbyItems(item) {
  if (!item) {
    bot.chat('Please specify an item! Example: "find diamond_ore"');
    return;
  }
  
  console.log(`Scanning for ${item} in a 16 block radius...`);
  
  const items = bot.findBlocks({
    matching: (block) => block.name === item,
    maxDistance: 16
  });
  
  if (items.length === 0) {
    bot.chat(`No ${item} found nearby`);
    return;
  }
  
  bot.chat(`Found ${items.length} ${item}(s)! Going to collect them!`);
  
  // Set mining state to prevent conflicts
  const wasMining = mining;
  mining = true;
  
  try {
    // Process each block one at a time to avoid pathfinding conflicts
    for (let i = 0; i < items.length; i++) {
      if (!mining) break;
      
      const itemPos = items[i];
      
      try {
        console.log(`Going to ${item} ${i + 1}/${items.length} at ${itemPos.x}, ${itemPos.y}, ${itemPos.z}`);
        
        // Clear any existing pathfinding goal first
        bot.pathfinder.setGoal(null);
        await sleep(100); // Small delay to ensure goal is cleared
        
        // Create a new goal and wait for it to complete
        const goal = new GoalNear(itemPos.x, itemPos.y, itemPos.z, 1);
        await bot.pathfinder.goto(goal);
        
        // Verify we're close enough before trying to mine
        const distance = bot.entity.position.distanceTo(itemPos);
        if (distance > 5) {
          console.log(`Too far from ${item} (distance: ${distance.toFixed(1)}), skipping...`);
          continue;
        }
        
        const block = bot.blockAt(itemPos);
        if (block && block.name === item) {
          await exposeVein(block, item);
        } else {
          console.log(`Block at position is no longer ${item}, skipping...`);
        }
        
        // Check hunger and inventory after each successful collection
        if (bot.food <= 6) await eatFood();
        if (isInventoryFull()) await saveItems();
        
        // Small delay between items to prevent overwhelming the server
        await sleep(500);
        
      } catch (error) {
        console.error(`Error reaching ${item} at ${itemPos.x}, ${itemPos.y}, ${itemPos.z}:`, error);
        console.log(`Couldn't reach ${item} ${i + 1}: ${error.message}`);
        
        // Clear pathfinding goal on error
        bot.pathfinder.setGoal(null);
        await sleep(500);
        continue;
      }
    }
    
    bot.chat(`Finished collecting all found ${item}!`);
    
  } finally {
    // Always clear the pathfinding goal and restore mining state
    bot.pathfinder.setGoal(null);
    mining = wasMining;
  }
}

async function exposeVein(initialBlock, targetItem) {
  // Use a set to track processed positions to avoid infinite loops
  const processed = new Set();
  const toProcess = [initialBlock.position];
  
  while (toProcess.length > 0) {
    const pos = toProcess.pop();
    const key = `${pos.x},${pos.y},${pos.z}`;
    
    if (processed.has(key)) continue;
    processed.add(key);
    
    const block = bot.blockAt(pos);
    if (!block || block.name !== targetItem) continue;
    
    try {
      // Check if we're close enough to mine this block
      const distance = bot.entity.position.distanceTo(pos);
      if (distance > 5) {
        // Try to get closer to this specific block
        const goal = new GoalNear(pos.x, pos.y, pos.z, 1);
        await bot.pathfinder.goto(goal);
      }
      
      // Make sure we have the right tool
      const toolCheck = await checkAndEquipTool(block);
      if (!toolCheck.success) {
        console.log(`Can't mine ${targetItem}: ${toolCheck.reason}`);
        continue;
      }
      
      console.log(`Mining ${targetItem} at ${pos.x}, ${pos.y}, ${pos.z}`);
      await bot.collectBlock.collect(block);
      
      // Check all 6 adjacent blocks for more of the same item type
      const adjacent = [
        pos.offset(1, 0, 0),  pos.offset(-1, 0, 0),  // X axis
        pos.offset(0, 1, 0),  pos.offset(0, -1, 0),  // Y axis  
        pos.offset(0, 0, 1),  pos.offset(0, 0, -1)   // Z axis
      ];
      
      for (const adjPos of adjacent) {
        const adjBlock = bot.blockAt(adjPos);
        if (adjBlock && adjBlock.name === targetItem) {
          toProcess.push(adjPos);
        }
      }
      
    } catch (error) {
      console.error(`Error mining ${targetItem} at ${pos}:`, error);
      continue;
    }
  }
}


async function fishing() { 
    if (bot.food <= 6) await eatFood();
    if (isInventoryFull()) await saveItems();

    if (!shouldKeepFishing) {
        nowFishing = false;
        return; // Stop if we shouldn't keep fishing
    }

    try { 
        await bot.equip(bot.registry.itemsByName.fishing_rod.id, 'hand') 
    } catch (err) { 
        return bot.chat(err.message) 
    } 
     
    nowFishing = true 
    console.log('Casting line...');
     
    try { 
        await bot.fish(); 
        console.log('Caught something!');
        
        // Recursive call - fish again if we should keep fishing
        if (shouldKeepFishing) {
            setTimeout(() => {
                fishing(); // Recursive call after delay
            }, 1000);
        } else {
            nowFishing = false;
        }
    } catch (err) { 
        bot.chat(err.message);
        nowFishing = false;
        
        // Retry on error if we should keep fishing
        if (shouldKeepFishing) {
            setTimeout(() => {
                fishing(); // Recursive call on error
            }, 2000);
        }
    } 
} 
 
async function startFishing() { 
    if (nowFishing) {
        console.log('Already fishing!');
        return;
    }

    shouldKeepFishing = true; // Set flag to enable continuous fishing

    const water = bot.findBlocks({ 
        matching: mcData.blocksByName.water.id, 
        maxDistance: 100, 
        count: 1 
    }); 
 
    if (!water || water.length === 0) { 
        bot.chat('I cannot find water'); 
        shouldKeepFishing = false;
        return 
    } 
 
    const waterPos = bot.blockAt(water[0]); 
    const waterAt = bot.blockAt(waterPos.position.offset(0, 1, 0)); 
 
    bot.pathfinder.setMovements(new Movements(bot, mcData)); 
    bot.pathfinder.setGoal(new GoalNear(waterPos.position.x, waterPos.position.y, waterPos.position.z, 2)); 
    console.log(waterPos)
    // No need for playerCollect listener with recursive approach
    
    bot.once('goal_reached', async () => { 
        await bot.lookAt(waterAt.position, false); 
        console.log('Starting continuous fishing'); 
        fishing(); 
    }); 

} 
   
function stopFishing() { 
    shouldKeepFishing = false; // This will stop the recursive loop
    
    console.log('I stopped fishing') 
    
    if (nowFishing) { 
        bot.activateItem(); // This will reel in the current line
        nowFishing = false;
    } 
} 

// Check for night time every minute
/*
setInterval(() => {
    if (isNightTime()) {
        findAndSleep();
    }
}, 60000); // Check every minute
*/
console.log('Chunk Mining Bot starting...');