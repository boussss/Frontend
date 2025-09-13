// plansController.js
const asyncHandler = require('express-async-handler');
const { User, Plan, PlanInstance, Transaction, Settings } = require('./models');

//=====================================================
//  FUNÇÕES DO LADO DO USUÁRIO
//=====================================================

/**
 * @desc    Obter todos os planos de investimento e o plano ativo do usuário
 * @route   GET /api/plans
 * @access  Private (usuário logado)
 */
const getAllAvailablePlans = asyncHandler(async (req, res) => {
    const user = await User.findById(req.user._id).populate({
        path: 'activePlanInstance',
        populate: { path: 'plan', model: 'Plan' }
    });
    
    const allPlans = await Plan.find({});
    
    res.json({
        plans: allPlans,
        activePlanInstance: user ? user.activePlanInstance : null,
    });
});

/**
 * @desc    Ativar um plano de investimento para um novo usuário (sem plano ativo)
 * @route   POST /api/plans/:planId/activate
 * @access  Private
 */
const activatePlan = asyncHandler(async (req, res) => {
    const { planId } = req.params;
    const { investedAmount } = req.body;
    const user = await User.findById(req.user._id);

    const settings = await Settings.findOne({ configKey: "main_settings" });
    if (!settings) {
        return res.status(500).json({ message: "Configurações do sistema não encontradas." });
    }

    if (user.activePlanInstance) {
        return res.status(400).json({ message: 'Você já possui um plano ativo. Para mudar, faça um upgrade.' });
    }

    const plan = await Plan.findById(planId);
    if (!plan) {
        return res.status(404).json({ message: 'Plano não encontrado.' });
    }

    const amount = Number(investedAmount);
    if (isNaN(amount) || amount < plan.minAmount || amount > plan.maxAmount) {
        return res.status(400).json({ message: `O valor do investimento deve estar entre ${plan.minAmount} MT e ${plan.maxAmount} MT.` });
    }

    let realAmountToPay = amount;
    let bonusAmountUsed = 0;

    if (user.bonusBalance > 0) {
        if (user.bonusBalance >= amount) {
            bonusAmountUsed = amount;
            realAmountToPay = 0;
        } else {
            bonusAmountUsed = user.bonusBalance;
            realAmountToPay = amount - user.bonusBalance;
        }
    }

    if (user.walletBalance < realAmountToPay) {
        return res.status(400).json({ message: 'Saldo real insuficiente para ativar este plano, mesmo com o bônus.' });
    }

    user.walletBalance -= realAmountToPay;
    user.bonusBalance -= bonusAmountUsed;

    const dailyProfit = plan.dailyYieldType === 'fixed' ? plan.dailyYieldValue : (amount * plan.dailyYieldValue) / 100;
    const startDate = new Date(); // << CORREÇÃO: Definir a data de início
    const endDate = new Date();
    endDate.setDate(startDate.getDate() + plan.durationDays);

    const newPlanInstance = await PlanInstance.create({
        user: user._id,
        plan: plan._id,
        investedAmount: amount,
        dailyProfit: dailyProfit,
        startDate: startDate,
        endDate: endDate,
        lastCollectedDate: startDate, // << CORREÇÃO: Inicializa a data da última coleta
    });
    
    user.activePlanInstance = newPlanInstance._id;
    await user.save();

    await Transaction.create({
        user: user._id,
        type: 'investment',
        amount: -amount,
        description: `Investimento no plano "${plan.name}"`,
    });

    if (user.invitedBy) {
        const referrer = await User.findById(user.invitedBy);
        if (referrer) {
            const commissionAmount = amount * (settings.referralCommissionRate / 100);
            referrer.walletBalance += commissionAmount;
            await referrer.save();

            await Transaction.create({
                user: referrer._id,
                type: 'commission',
                amount: commissionAmount,
                description: `Comissão por ativação de plano do usuário ${user.userId}`,
            });
        }
    }

    res.status(201).json({ message: 'Plano ativado com sucesso!', planInstance: newPlanInstance });
});

/**
 * @desc    Fazer upgrade de um plano ativo para um superior
 * @route   POST /api/plans/upgrade/:newPlanId
 * @access  Private
 */
const upgradePlan = asyncHandler(async (req, res) => {
    const { newPlanId } = req.params;
    const user = await User.findById(req.user._id).populate({
        path: 'activePlanInstance',
        populate: { path: 'plan', model: 'Plan' }
    });

    if (!user.activePlanInstance) {
        return res.status(400).json({ message: 'Você não tem um plano ativo para fazer upgrade.' });
    }

    const newPlan = await Plan.findById(newPlanId);
    if (!newPlan) {
        return res.status(404).json({ message: 'Novo plano não encontrado.' });
    }
    
    const oldPlanInstance = user.activePlanInstance;
    const oldPlan = oldPlanInstance.plan;

    if (newPlan.minAmount <= oldPlan.minAmount) {
        return res.status(400).json({ message: 'Você só pode fazer upgrade para um plano de valor superior.' });
    }

    const priceDifference = newPlan.minAmount - oldPlan.minAmount;
    if (user.walletBalance < priceDifference) {
        return res.status(400).json({ message: `Saldo insuficiente. Você precisa de ${priceDifference} MT para este upgrade.` });
    }

    user.walletBalance -= priceDifference;
    
    oldPlanInstance.status = 'expired';
    await oldPlanInstance.save();
    
    const dailyProfit = newPlan.dailyYieldType === 'fixed' ? newPlan.dailyYieldValue : (newPlan.minAmount * newPlan.dailyYieldValue) / 100;
    const startDate = new Date(); // << CORREÇÃO: Definir a data de início
    const endDate = new Date();
    endDate.setDate(startDate.getDate() + newPlan.durationDays);

    const newPlanInstance = await PlanInstance.create({
        user: user._id,
        plan: newPlan._id,
        investedAmount: newPlan.minAmount,
        dailyProfit: dailyProfit,
        startDate: startDate,
        endDate: endDate,
        lastCollectedDate: startDate, // << CORREÇÃO: Inicializa a data da última coleta
    });

    user.activePlanInstance = newPlanInstance._id;
    await user.save();

    await Transaction.create({
        user: user._id,
        type: 'investment',
        amount: -priceDifference,
        description: `Upgrade do plano "${oldPlan.name}" para "${newPlan.name}"`,
    });

    res.json({ message: 'Upgrade de plano realizado com sucesso!' });
});

/**
 * @desc    Coletar o lucro diário de um plano ativo
 * @route   POST /api/plans/collect
 * @access  Private
 */
const collectDailyProfit = asyncHandler(async (req, res) => {
    const user = await User.findById(req.user._id).populate('activePlanInstance');
    
    const settings = await Settings.findOne({ configKey: "main_settings" });
    if (!settings) {
        return res.status(500).json({ message: "Configurações do sistema não encontradas." });
    }

    if (!user.activePlanInstance) {
        return res.status(400).json({ message: 'Você não tem um plano ativo para coletar lucros.' });
    }
    
    const planInstance = user.activePlanInstance;

    if (new Date() > new Date(planInstance.endDate)) {
        planInstance.status = 'expired';
        await planInstance.save();
        user.activePlanInstance = null;
        await user.save();
        return res.status(400).json({ message: 'Este plano já expirou.' });
    }

    const lastCollectionBase = planInstance.lastCollectedDate || planInstance.startDate;
    const nextCollectionTime = new Date(lastCollectionBase).getTime() + (24 * 60 * 60 * 1000);

    if (Date.now() < nextCollectionTime) {
        const remainingHours = ((nextCollectionTime - Date.now()) / (1000 * 60 * 60)).toFixed(1);
        return res.status(400).json({ message: `Você já coletou hoje. Tente novamente em aproximadamente ${remainingHours} horas.` });
    }

    const profit = planInstance.dailyProfit;
    
    user.walletBalance += profit;
    planInstance.lastCollectedDate = new Date();
    planInstance.totalCollected += profit;
    
    await planInstance.save();
    await user.save();

    await Transaction.create({ user: user._id, type: 'collection', amount: profit, description: 'Coleta de rendimento diário' });

    if (user.invitedBy) {
        const referrer = await User.findById(user.invitedBy);
        if (referrer && referrer.activePlanInstance) {
            const dailyCommission = profit * (settings.dailyCommissionRate / 100);
            referrer.walletBalance += dailyCommission;
            await referrer.save();
            await Transaction.create({ user: referrer._id, type: 'commission', amount: dailyCommission, description: `Comissão diária do lucro do usuário ${user.userId}` });
        }
    }
    
    res.json({ message: `Você coletou ${formatCurrency(profit)} MT com sucesso.` });
});

/**
 * @desc    Renovar um plano expirado
 * @route   POST /api/plans/:instanceId/renew
 * @access  Private
 */
const renewPlan = asyncHandler(async (req, res) => {
    const { instanceId } = req.params;
    const user = await User.findById(req.user._id);

    const oldInstance = await PlanInstance.findById(instanceId).populate('plan');
    if (!oldInstance || oldInstance.user.toString() !== user._id.toString()) {
        return res.status(404).json({ message: 'Histórico de plano não encontrado.' });
    }

    if (oldInstance.status !== 'expired') {
        return res.status(400).json({ message: 'Apenas planos expirados podem ser renovados.' });
    }

    if (user.activePlanInstance) {
        return res.status(400).json({ message: 'Você já possui um plano ativo. Não é possível renovar outro no momento.' });
    }

    const planToRenew = oldInstance.plan;
    const renewalCost = planToRenew.minAmount;

    if (user.walletBalance < renewalCost) {
        return res.status(400).json({ message: `Saldo insuficiente. Você precisa de ${renewalCost} MT para renovar.` });
    }

    user.walletBalance -= renewalCost;

    const dailyProfit = planToRenew.dailyYieldType === 'fixed' 
        ? planToRenew.dailyYieldValue 
        : (renewalCost * planToRenew.dailyYieldValue) / 100;
        
    const startDate = new Date(); // << CORREÇÃO: Definir a data de início
    const endDate = new Date();
    endDate.setDate(startDate.getDate() + planToRenew.durationDays);

    const newInstance = await PlanInstance.create({
        user: user._id,
        plan: planToRenew._id,
        investedAmount: renewalCost,
        dailyProfit: dailyProfit,
        startDate: startDate,
        endDate: endDate,
        lastCollectedDate: startDate, // << CORREÇÃO: Inicializa a data da última coleta
    });

    user.activePlanInstance = newInstance._id;
    await user.save();

    await Transaction.create({
        user: user._id, type: 'investment', amount: -renewalCost,
        description: `Renovação do plano "${planToRenew.name}"`,
    });

    res.status(200).json({ message: 'Plano renovado com sucesso!' });
});


//=====================================================
//  FUNÇÕES DO LADO DO ADMIN
//=====================================================

const getAllPlansForAdmin = asyncHandler(async (req, res) => {
    const plans = await Plan.find({});
    res.json(plans);
});

const createPlan = asyncHandler(async (req, res) => {
    const { name, minAmount, maxAmount, dailyYieldType, dailyYieldValue, durationDays, hashRate } = req.body;
    if (!name || !minAmount || !maxAmount || !dailyYieldType || !dailyYieldValue || !durationDays) {
        return res.status(400).json({ message: 'Todos os campos, exceto a imagem e hash, são obrigatórios.' });
    }
    const plan = await Plan.create({ name, minAmount, maxAmount, dailyYieldType, dailyYieldValue, durationDays, hashRate, imageUrl: req.file ? req.file.path : '' });
    res.status(201).json(plan);
});

const updatePlan = asyncHandler(async (req, res) => {
    const plan = await Plan.findById(req.params.id);
    if (!plan) { return res.status(404).json({ message: 'Plano não encontrado.' }); }
    Object.assign(plan, req.body);
    if (req.file) { plan.imageUrl = req.file.path; }
    const updatedPlan = await plan.save();
    res.json(updatedPlan);
});

const deletePlan = asyncHandler(async (req, res) => {
    const plan = await Plan.findById(req.params.id);
    if (!plan) { return res.status(404).json({ message: 'Plano não encontrado.' }); }
    const activeInstances = await PlanInstance.countDocuments({ plan: plan._id, status: 'active' });
    if (activeInstances > 0) { return res.status(400).json({ message: `Não é possível deletar este plano, pois ${activeInstances} usuário(s) o têm ativo.` }); }
    await plan.deleteOne();
    res.json({ message: 'Plano deletado com sucesso.' });
});


module.exports = {
    getAllAvailablePlans,
    activatePlan,
    upgradePlan,
    collectDailyProfit,
    renewPlan,
    getAllPlansForAdmin,
    createPlan,
    updatePlan,
    deletePlan,
};

function formatCurrency(value) {
    return new Intl.NumberFormat('pt-MZ', { style: 'currency', currency: 'MZN' }).format(value);
}